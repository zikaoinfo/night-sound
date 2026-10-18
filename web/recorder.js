// recorder.js — raw-PCM ring buffer + WAV encoding.
//
// We keep a rolling buffer of the most recent audio so that, the moment an
// event ends, we can cut a short clip of exactly that moment and let you
// play it back or download it. Uses ScriptProcessorNode for broad support;
// AudioWorklet is the modern upgrade (see README).

export class RingRecorder {
  constructor(audioCtx, seconds = 20) {
    this.ctx = audioCtx;
    this.sampleRate = audioCtx.sampleRate;
    this.size = Math.ceil(this.sampleRate * seconds);
    this.buffer = new Float32Array(this.size);
    this.writePos = 0;          // next write index (mod size)
    this.written = 0;           // total samples ever written
    this.node = null;
  }

  connect(sourceNode) {
    const bufSize = 4096;
    const proc = this.ctx.createScriptProcessor(bufSize, 1, 1);
    proc.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      for (let i = 0; i < input.length; i++) {
        this.buffer[this.writePos] = input[i];
        this.writePos = (this.writePos + 1) % this.size;
      }
      this.written += input.length;
    };
    // ScriptProcessor must reach a destination to run; route through a muted gain.
    const sink = this.ctx.createGain();
    sink.gain.value = 0;
    sourceNode.connect(proc);
    proc.connect(sink);
    sink.connect(this.ctx.destination);
    this.node = proc;
  }

  // Extract samples for an absolute time window [startSample, endSample).
  // Returns null if the window has already scrolled out of the ring buffer.
  extract(startSample, endSample) {
    const oldest = Math.max(0, this.written - this.size);
    if (startSample < oldest) return null;
    const n = endSample - startSample;
    if (n <= 0) return null;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const abs = startSample + i;
      out[i] = this.buffer[abs % this.size];
    }
    return out;
  }

  disconnect() {
    if (this.node) {
      this.node.onaudioprocess = null;
      try { this.node.disconnect(); } catch (_) {}
      this.node = null;
    }
  }
}

// Encode mono Float32 samples [-1,1] as a 16-bit PCM WAV Blob.
export function encodeWav(samples, sampleRate) {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const view = new DataView(buf);
  const wstr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };

  wstr(0, "RIFF");
  view.setUint32(4, 36 + n * 2, true);
  wstr(8, "WAVE");
  wstr(12, "fmt ");
  view.setUint32(16, 16, true);         // PCM chunk size
  view.setUint16(20, 1, true);          // audio format = PCM
  view.setUint16(22, 1, true);          // channels
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true);          // block align
  view.setUint16(34, 16, true);         // bits per sample
  wstr(36, "data");
  view.setUint32(40, n * 2, true);

  let off = 44;
  for (let i = 0; i < n; i++) {
    let s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return new Blob([buf], { type: "audio/wav" });
}
