package app.sonora.recorder;

import android.Manifest;
import android.content.Intent;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.File;
import org.json.JSONObject;

/** Android side of the SonoraRecorder plugin; same API as the iOS plugin. */
@CapacitorPlugin(
    name = "SonoraRecorder",
    permissions = { @Permission(strings = { Manifest.permission.RECORD_AUDIO }, alias = "microphone") }
)
public class SonoraRecorderPlugin extends Plugin {
    private ClipPlayer player;

    @Override
    public void load() {
        player = new ClipPlayer(state -> {
            try { notifyListeners("playback", JSObject.fromJSONObject(state)); } catch (Exception ignored) { }
        });
        RecorderService.setCallback(new RecorderService.Callback() {
            @Override
            public void onEvent(JSONObject event) {
                try {
                    notifyListeners("soundEvent", JSObject.fromJSONObject(event));
                } catch (Exception ignored) { }
            }

            @Override
            public void onLevel(double t, double db, double floor, double threshold) {
                JSObject o = new JSObject();
                o.put("t", t);
                o.put("db", db);
                o.put("floor", floor);
                o.put("threshold", threshold);
                notifyListeners("level", o);
            }

            @Override
            public void onWaiting(double remainingS) {
                JSObject o = new JSObject();
                o.put("t", 0);
                o.put("waitingS", remainingS);
                notifyListeners("level", o);
            }
        });
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call, "microphonePermissionResult");
            return;
        }
        startService(call);
    }

    @PermissionCallback
    private void microphonePermissionResult(PluginCall call) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) {
            startService(call);
        } else {
            call.reject("Microphone access is off. Turn it on in Settings > Apps > Sonora.", "PERMISSION_DENIED");
        }
    }

    private void startService(PluginCall call) {
        RecorderService running = RecorderService.current();
        if (running != null && running.isRecording()) {
            call.reject("A session is already recording.", "ALREADY_RECORDING");
            return;
        }
        String id = SessionStore.newId();
        Intent intent = new Intent(getContext(), RecorderService.class)
            .putExtra("sessionId", id)
            .putExtra("sensitivity", call.getString("sensitivity", "normal"))
            .putExtra("keepClips", call.getBoolean("keepClips", true))
            .putExtra("fullRecording", call.getBoolean("fullRecording", false))
            .putExtra("tags", stringArray(call.getArray("tags")))
            .putExtra("startDelayS", call.getDouble("startDelayS") == null ? 0.0 : call.getDouble("startDelayS"));
        ContextCompat.startForegroundService(getContext(), intent);
        JSObject result = new JSObject();
        result.put("sessionId", id);
        call.resolve(result);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        RecorderService service = RecorderService.current();
        if (service == null || !service.isRecording()) {
            call.reject("Nothing is recording.", "NOT_RECORDING");
            return;
        }
        try {
            call.resolve(JSObject.fromJSONObject(service.stopAndSave()));
        } catch (Exception e) {
            call.reject("Could not finish the session.", "STOP_FAILED", e);
        }
    }

    @PluginMethod
    public void status(PluginCall call) {
        RecorderService service = RecorderService.current();
        try {
            if (service == null) {
                JSObject o = new JSObject();
                o.put("recording", false);
                call.resolve(o);
            } else {
                call.resolve(JSObject.fromJSONObject(service.status()));
            }
        } catch (Exception e) {
            call.reject("Could not read status.", "STATUS_FAILED", e);
        }
    }

    @PluginMethod
    public void listSessions(PluginCall call) {
        JSObject o = new JSObject();
        o.put("sessions", SessionStore.list(getContext()));
        call.resolve(o);
    }

    @PluginMethod
    public void getSession(PluginCall call) {
        String id = call.getString("id");
        try {
            JSONObject session = SessionStore.load(getContext(), id);
            File dir = new File(SessionStore.root(getContext()), id);
            session.put("baseUrl", "file://" + dir.getAbsolutePath() + "/");
            call.resolve(JSObject.fromJSONObject(session));
        } catch (Exception e) {
            call.reject("Session not found.", "NOT_FOUND");
        }
    }

    /** updateSession({ id, tags, rating?, note? }) */
    @PluginMethod
    public void updateSession(PluginCall call) {
        String id = call.getString("id");
        if (id == null) {
            call.reject("Missing id.", "BAD_REQUEST");
            return;
        }
        JSONObject meta = SessionStore.metaJSON(stringArray(call.getArray("tags")),
                call.getInt("rating"), call.getString("note"));
        RecorderService service = RecorderService.current();
        boolean ok = (service != null && service.updateMeta(id, meta))
                || SessionStore.updateMeta(getContext(), id, meta);
        if (ok) call.resolve();
        else call.reject("Session not found.", "NOT_FOUND");
    }

    /** importSession({ json }) -> { result: "added" | "exists" } */
    @PluginMethod
    public void importSession(PluginCall call) {
        String json = call.getString("json");
        String result = json == null ? null : SessionStore.importSession(getContext(), json);
        if (result == null) {
            call.reject("That doesn't look like a Sonora night.", "INVALID");
            return;
        }
        JSObject o = new JSObject();
        o.put("result", result);
        call.resolve(o);
    }

    /** writeShareFile({ name, data (base64) }) -> { uri }: a file in cache/share for the Share plugin. */
    @PluginMethod
    public void writeShareFile(PluginCall call) {
        String name = call.getString("name");
        String data = call.getString("data");
        if (name == null || !name.matches("[A-Za-z0-9._-]{1,100}") || data == null) {
            call.reject("Missing or invalid file.", "BAD_REQUEST");
            return;
        }
        try {
            File dir = new File(getContext().getCacheDir(), "share");
            if (!dir.isDirectory() && !dir.mkdirs()) throw new IllegalStateException("mkdir failed");
            File file = new File(dir, name);
            try (java.io.FileOutputStream out = new java.io.FileOutputStream(file)) {
                out.write(android.util.Base64.decode(data, android.util.Base64.DEFAULT));
            }
            JSObject o = new JSObject();
            o.put("uri", android.net.Uri.fromFile(file).toString());
            call.resolve(o);
        } catch (Exception e) {
            call.reject("Could not write the file.", "WRITE_FAILED", e);
        }
    }

    /** A file inside a stored night: "full.m4a" or "clips/clip-00001.wav"; null if invalid or missing. */
    private File sessionFile(PluginCall call) {
        String id = call.getString("id"), file = call.getString("file");
        if (id == null || file == null || !id.matches("\\d{8}-\\d{6}")
                || !file.matches("full\\.m4a|clips/clip-\\d{5}\\.wav")) return null;
        File f = new File(new File(SessionStore.root(getContext()), id), file);
        return f.isFile() ? f : null;
    }

    /** playFile({ id, file, at? }) — "playback" events report progress. */
    @PluginMethod
    public void playFile(PluginCall call) {
        File f = sessionFile(call);
        if (f == null) { call.reject("That recording isn't on this phone any more.", "NOT_FOUND"); return; }
        double at = call.getDouble("at") == null ? 0 : call.getDouble("at");
        String id = call.getString("id"), file = call.getString("file");
        getActivity().runOnUiThread(() -> {
            try { player.play(f, at, id, file); call.resolve(); }
            catch (Exception e) { call.reject("Couldn't play it.", "PLAY_FAILED", e); }
        });
    }

    @PluginMethod
    public void pausePlayback(PluginCall call) { getActivity().runOnUiThread(() -> { player.pause(); call.resolve(); }); }

    @PluginMethod
    public void resumePlayback(PluginCall call) { getActivity().runOnUiThread(() -> { player.resume(); call.resolve(); }); }

    @PluginMethod
    public void seekPlayback(PluginCall call) {
        double t = call.getDouble("t") == null ? 0 : call.getDouble("t");
        getActivity().runOnUiThread(() -> { player.seek(t); call.resolve(); });
    }

    @PluginMethod
    public void stopPlayback(PluginCall call) { getActivity().runOnUiThread(() -> { player.stop(true); call.resolve(); }); }

    /** readSessionFile({ id, file }) -> { data (base64) } — clips for the report. */
    @PluginMethod
    public void readSessionFile(PluginCall call) {
        File f = sessionFile(call);
        if (f == null) { call.reject("File not found.", "NOT_FOUND"); return; }
        try (java.io.FileInputStream in = new java.io.FileInputStream(f)) {
            byte[] data = new byte[(int) f.length()];
            int off = 0, n;
            while (off < data.length && (n = in.read(data, off, data.length - off)) > 0) off += n;
            JSObject o = new JSObject();
            o.put("data", android.util.Base64.encodeToString(data, android.util.Base64.NO_WRAP));
            call.resolve(o);
        } catch (Exception e) {
            call.reject("File not found.", "NOT_FOUND", e);
        }
    }

    private static String[] stringArray(JSArray a) {
        if (a == null) return new String[0];
        String[] out = new String[a.length()];
        for (int i = 0; i < a.length(); i++) out[i] = a.optString(i);
        return out;
    }

    @PluginMethod
    public void deleteSession(PluginCall call) {
        String id = call.getString("id");
        if (id == null) {
            call.reject("Missing id.", "BAD_REQUEST");
        } else if (SessionStore.delete(getContext(), id)) {
            call.resolve();
        } else {
            call.reject("Could not delete session.", "DELETE_FAILED");
        }
    }
}
