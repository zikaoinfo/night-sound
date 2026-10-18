package app.sonora.recorder;

import android.Manifest;
import android.content.Intent;
import androidx.core.content.ContextCompat;
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

    @Override
    public void load() {
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
            .putExtra("keepClips", call.getBoolean("keepClips", true));
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
