package app.sonora.recorder;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import org.json.JSONObject;

/**
 * Foreground service that records the microphone all night. Android requires
 * a visible notification for this; it reads "Sonora is listening". Audio is
 * read at 16 kHz mono and fed to SnoreEngine on a dedicated thread.
 */
public class RecorderService extends Service {
    static final String CHANNEL_ID = "sonora_recording";
    static final int NOTIFICATION_ID = 4711;

    interface Callback {
        void onEvent(JSONObject event);
        void onLevel(double t, double db, double floor, double threshold);
    }

    private static volatile RecorderService current;
    private static volatile Callback callback;

    static RecorderService current() { return current; }
    static void setCallback(Callback c) { callback = c; }

    private volatile boolean running = false;
    private volatile double elapsedS = 0;
    private volatile double noiseFloor = -50;
    private Thread thread;
    private AudioRecord record;
    private PowerManager.WakeLock wakeLock;
    private SessionStore store;
    private SnoreEngine engine;

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (running || intent == null) return START_NOT_STICKY;
        startInForeground();
        String id = intent.getStringExtra("sessionId");
        String sensitivity = intent.getStringExtra("sensitivity");
        boolean keepClips = intent.getBooleanExtra("keepClips", true);
        String[] tags = intent.getStringArrayExtra("tags");
        try {
            begin(id != null ? id : SessionStore.newId(), sensitivity != null ? sensitivity : "normal", keepClips, tags);
            current = this;
        } catch (Exception e) {
            shutdown();
        }
        return START_NOT_STICKY;
    }

    boolean isRecording() { return running; }

    JSONObject status() throws Exception {
        JSONObject o = new JSONObject();
        o.put("recording", running);
        if (running) {
            o.put("sessionId", store.id);
            o.put("elapsedS", elapsedS);
            o.put("events", store.eventCount());
            o.put("noiseFloorDbfs", noiseFloor);
        }
        return o;
    }

    /** Stops recording, writes the final session.json and returns it with baseUrl. */
    JSONObject stopAndSave() throws Exception {
        running = false;
        if (thread != null) thread.join(3000);   // the thread flushes and saves on exit
        JSONObject session = SessionStore.load(this, store.id);
        session.put("baseUrl", "file://" + store.dir.getAbsolutePath() + "/");
        shutdown();
        return session;
    }

    /** Notes for the live night; false if `id` isn't the one recording. */
    boolean updateMeta(String id, JSONObject meta) {
        if (!running || store == null || !store.id.equals(id)) return false;
        store.setMeta(meta);
        return true;
    }

    private void begin(String id, String sensitivity, boolean keepClips, String[] tags) {
        int sr = SnoreEngine.SAMPLE_RATE;
        int minBuf = AudioRecord.getMinBufferSize(sr, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
        int source = unprocessedSupported() ? MediaRecorder.AudioSource.UNPROCESSED
                                            : MediaRecorder.AudioSource.VOICE_RECOGNITION;
        record = new AudioRecord(source, sr, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT,
                                 Math.max(minBuf, sr));  // >= 0.5 s of 16-bit audio
        if (record.getState() != AudioRecord.STATE_INITIALIZED) {
            throw new IllegalStateException("Microphone unavailable");
        }

        engine = new SnoreEngine();
        if ("low".equals(sensitivity)) { engine.threshOverFloorDb = 12; engine.snoreThreshold = 0.6; }
        if ("high".equals(sensitivity)) { engine.threshOverFloorDb = 6; engine.snoreThreshold = 0.4; }
        store = new SessionStore(this, id, sensitivity, keepClips, tags);
        engine.setListener((ev, clip) -> {
            try {
                JSONObject json = store.add(ev, clip);
                Callback cb = callback;
                if (cb != null) cb.onEvent(json);
            } catch (Exception ignored) {
                // Keep recording even if one event can't be stored.
            }
        });

        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Sonora:recording");
        wakeLock.acquire(12L * 60 * 60 * 1000);   // a night, at most

        running = true;
        record.startRecording();
        thread = new Thread(this::loop, "SonoraRecorder");
        thread.start();
    }

    private void loop() {
        short[] pcm = new short[1600];
        float[] samples = new float[1600];
        long lastLevel = 0, lastSave = System.currentTimeMillis();
        try {
            store.save(0, engine.noiseFloor(), engine.envelope(), null);
            while (running) {
                int n = record.read(pcm, 0, pcm.length);
                if (n <= 0) { Thread.sleep(20); continue; }
                for (int i = 0; i < n; i++) samples[i] = pcm[i] / 32768f;
                engine.process(samples, n);
                elapsedS = engine.elapsedS();
                noiseFloor = engine.noiseFloor();

                long now = System.currentTimeMillis();
                Callback cb = callback;
                if (cb != null && now - lastLevel >= 250) {
                    lastLevel = now;
                    cb.onLevel(elapsedS, engine.lastDb(), noiseFloor, engine.threshold());
                }
                if (now - lastSave >= 30_000) {
                    lastSave = now;
                    store.save(elapsedS, noiseFloor, engine.envelope(), null);
                }
            }
            engine.flush();
            store.save(engine.elapsedS(), engine.noiseFloor(), engine.envelope(), SessionStore.iso(new java.util.Date()));
        } catch (Exception ignored) {
            // The last periodic save is still on disk.
        }
    }

    private boolean unprocessedSupported() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return false;
        AudioManager am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        return "true".equals(am.getProperty(AudioManager.PROPERTY_SUPPORT_AUDIO_SOURCE_UNPROCESSED));
    }

    private void startInForeground() {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.createNotificationChannel(new NotificationChannel(
                    CHANNEL_ID, "Sleep recording", NotificationManager.IMPORTANCE_LOW));
        }
        Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent open = launch == null ? null : PendingIntent.getActivity(
                this, 0, launch, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification n = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("Sonora is listening")
                .setContentText("Recording sounds while you sleep. Audio stays on this phone.")
                .setSmallIcon(android.R.drawable.ic_btn_speak_now)
                .setOngoing(true)
                .setContentIntent(open)
                .build();
        ServiceCompat.startForeground(this, NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
    }

    private void shutdown() {
        running = false;
        if (record != null) {
            try { record.stop(); } catch (Exception ignored) { }
            record.release();
            record = null;
        }
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        current = null;
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    @Override
    public void onDestroy() {
        if (running) {
            running = false;
            try { if (thread != null) thread.join(3000); } catch (InterruptedException ignored) { }
            shutdown();
        }
        super.onDestroy();
    }
}
