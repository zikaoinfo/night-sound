package app.sonora.recorder;

import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.os.Handler;
import android.os.Looper;
import java.io.File;
import org.json.JSONObject;

/** Plays a night's clip or full recording natively; reports progress ~4×/s. */
final class ClipPlayer {
    interface Listener { void onState(JSONObject state); }

    private final Handler main = new Handler(Looper.getMainLooper());
    private final Listener listener;
    private MediaPlayer player;
    private String id = "", file = "";
    private final Runnable tick = new Runnable() {
        @Override public void run() {
            if (player != null && player.isPlaying()) {
                emit("playing");
                main.postDelayed(this, 250);
            }
        }
    };

    ClipPlayer(Listener listener) { this.listener = listener; }

    /** Main thread only. */
    void play(File f, double atS, String id, String file) throws Exception {
        stop(false);
        MediaPlayer p = new MediaPlayer();
        p.setAudioAttributes(new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build());
        p.setDataSource(f.getAbsolutePath());
        p.prepare();
        p.setOnCompletionListener(mp -> {
            main.removeCallbacks(tick);
            emit("ended", mp.getDuration() / 1000.0);
            release();
        });
        int ms = (int) Math.max(0, Math.min(atS * 1000, p.getDuration() - 50));
        p.seekTo(ms);
        p.start();
        player = p;
        this.id = id;
        this.file = file;
        main.post(tick);
        emit("playing");
    }

    void pause() {
        if (player == null) return;
        player.pause();
        main.removeCallbacks(tick);
        emit("paused");
    }

    void resume() {
        if (player == null) return;
        player.start();
        main.post(tick);
        emit("playing");
    }

    void seek(double t) {
        if (player == null) return;
        player.seekTo((int) Math.max(0, Math.min(t * 1000, player.getDuration() - 50)));
        emit(player.isPlaying() ? "playing" : "paused");
    }

    void stop(boolean notify) {
        main.removeCallbacks(tick);
        if (player == null) return;
        try { player.stop(); } catch (Exception ignored) { }
        if (notify) emit("stopped");
        release();
    }

    private void release() {
        if (player != null) { player.release(); player = null; }
    }

    private void emit(String state) {
        emit(state, player == null ? 0 : player.getCurrentPosition() / 1000.0);
    }

    private void emit(String state, double t) {
        try {
            JSONObject o = new JSONObject();
            o.put("state", state);
            o.put("t", t);
            o.put("duration", player == null ? 0 : player.getDuration() / 1000.0);
            o.put("id", id);
            o.put("file", file);
            listener.onState(o);
        } catch (Exception ignored) { }
    }
}
