class PCMCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetRate = 16000;
    this.ratio = sampleRate / this.targetRate;
    this.phase = 0;
    this.buffer = [];
    this.chunkSize = 640;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;

    for (let i = 0; i < channel.length; i++) {
      this.phase += 1 / this.ratio;
      if (this.phase >= 1) {
        this.phase -= 1;
        this.buffer.push(channel[i]);
      }
    }

    while (this.buffer.length >= this.chunkSize) {
      const samples = this.buffer.splice(0, this.chunkSize);
      const pcm = new Int16Array(samples.length);
      for (let j = 0; j < samples.length; j++) {
        const clamped = Math.max(-1, Math.min(1, samples[j]));
        pcm[j] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      }
      this.port.postMessage(pcm.buffer, [pcm.buffer]);
    }

    return true;
  }
}

registerProcessor('pcm-capture-processor', PCMCaptureProcessor);
