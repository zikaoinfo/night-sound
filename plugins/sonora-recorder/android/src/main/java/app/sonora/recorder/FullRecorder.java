package app.sonora.recorder;

import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaFormat;
import android.media.MediaMuxer;
import java.io.File;
import java.io.IOException;
import java.nio.ByteBuffer;

/**
 * Encodes the whole night to AAC in an .m4a file (16 kHz mono, 32 kbps — about
 * 115 MB per 8 hours). Fed from the recording thread with the same 16-bit PCM
 * the detector sees. Not thread-safe.
 */
final class FullRecorder {
    private static final int BITRATE = 32_000;
    private static final long TIMEOUT_US = 10_000;

    private final MediaCodec codec;
    private final MediaMuxer muxer;
    private final MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
    private int track = -1;
    private boolean muxing = false;
    private long samplesIn = 0;

    FullRecorder(File out) throws IOException {
        MediaFormat format = MediaFormat.createAudioFormat(
                MediaFormat.MIMETYPE_AUDIO_AAC, SnoreEngine.SAMPLE_RATE, 1);
        format.setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC);
        format.setInteger(MediaFormat.KEY_BIT_RATE, BITRATE);
        format.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 16 * 1024);
        codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC);
        codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
        codec.start();
        muxer = new MediaMuxer(out.getAbsolutePath(), MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4);
    }

    /** Encode `n` samples of 16-bit mono PCM. */
    void write(short[] pcm, int n) {
        int offset = 0, stalls = 0;
        while (offset < n) {
            int index = codec.dequeueInputBuffer(TIMEOUT_US);
            if (index < 0) {
                drain(false);
                if (++stalls > 20) return;   // encoder stuck: drop this chunk rather than stall recording
                continue;
            }
            ByteBuffer in = codec.getInputBuffer(index);
            in.clear();
            int count = Math.min(n - offset, in.remaining() / 2);
            for (int i = 0; i < count; i++) in.putShort(pcm[offset + i]);
            codec.queueInputBuffer(index, 0, count * 2, presentationUs(), 0);
            samplesIn += count;
            offset += count;
            drain(false);
        }
    }

    /** Flush and close the file. Safe to call once. */
    void finish() {
        try {
            int index = codec.dequeueInputBuffer(TIMEOUT_US * 10);
            if (index >= 0) {
                codec.queueInputBuffer(index, 0, 0, presentationUs(), MediaCodec.BUFFER_FLAG_END_OF_STREAM);
            }
            drain(true);
        } catch (Exception ignored) {
            // Keep whatever made it into the file.
        }
        try { codec.stop(); } catch (Exception ignored) { }
        codec.release();
        try { if (muxing) muxer.stop(); } catch (Exception ignored) { }
        muxer.release();
    }

    private long presentationUs() {
        return samplesIn * 1_000_000L / SnoreEngine.SAMPLE_RATE;
    }

    private void drain(boolean untilEnd) {
        int idle = 0;
        while (true) {
            int index = codec.dequeueOutputBuffer(info, untilEnd ? TIMEOUT_US * 10 : 0);
            if (index == MediaCodec.INFO_TRY_AGAIN_LATER) {
                if (!untilEnd || ++idle > 50) return;   // give up after ~5 s waiting for the end
                continue;
            }
            if (index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                track = muxer.addTrack(codec.getOutputFormat());
                muxer.start();
                muxing = true;
                continue;
            }
            if (index < 0) continue;
            ByteBuffer out = codec.getOutputBuffer(index);
            boolean config = (info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0;
            if (muxing && !config && info.size > 0 && out != null) {
                out.position(info.offset);
                out.limit(info.offset + info.size);
                muxer.writeSampleData(track, out, info);
            }
            codec.releaseOutputBuffer(index, false);
            if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) return;
        }
    }
}
