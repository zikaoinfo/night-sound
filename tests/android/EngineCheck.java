import app.sonora.recorder.SnoreEngine;

import java.io.DataInputStream;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayList;
import java.util.List;

/**
 * Runs the Android/Java SnoreEngine on raw 16 kHz mono float32 audio and
 * prints the summary, so it can be compared with the Python engine.
 *
 *   ffmpeg -i night.wav -ac 1 -ar 16000 -f f32le night.f32
 *   javac -d build plugins/sonora-recorder/android/src/main/java/app/sonora/recorder/SnoreEngine.java tests/android/EngineCheck.java
 *   java -cp build EngineCheck night.f32 [first-clip.wav]
 */
public class EngineCheck {
    public static void main(String[] args) throws Exception {
        SnoreEngine engine = new SnoreEngine();
        List<SnoreEngine.Event> events = new ArrayList<>();
        float[][] firstClip = {null};
        engine.setListener((ev, clip) -> {
            events.add(ev);
            if (firstClip[0] == null && ev.isSnore) firstClip[0] = clip;
        });

        byte[] raw = new DataInputStream(new FileInputStream(args[0])).readAllBytes();
        ByteBuffer bb = ByteBuffer.wrap(raw).order(ByteOrder.LITTLE_ENDIAN);
        float[] chunk = new float[1365];  // ~what the Android read loop delivers
        while (bb.remaining() >= 4) {
            int n = 0;
            while (n < chunk.length && bb.remaining() >= 4) chunk[n++] = bb.getFloat();
            engine.process(chunk, n);
        }
        engine.flush();

        SnoreEngine.Summary s = SnoreEngine.summarize(events, engine.elapsedS());
        System.out.printf("duration_s=%.1f noise_floor=%.1f events=%d snore_events=%d episodes=%d "
                        + "weird=%d snore_pct=%.1f score=%.1f envelope_s=%d%n",
                engine.elapsedS(), engine.noiseFloor(), events.size(), s.snoreEvents, s.episodes,
                s.weirdSounds, s.snorePercent, s.snoreScore, engine.envelope().length);
        for (SnoreEngine.Event e : events) {
            System.out.printf("  %6.2fs %-5s p=%.2f low=%.2f cen=%4.0f f0=%3.0f %s%n",
                    e.startS, e.isSnore ? "snore" : "other", e.snoreProb, e.lowRatio,
                    e.centroid, e.f0, e.intensity);
        }
        if (args.length > 1 && firstClip[0] != null) {
            try (FileOutputStream out = new FileOutputStream(args[1])) {
                out.write(SnoreEngine.wav(firstClip[0]));
            }
        }
    }
}
