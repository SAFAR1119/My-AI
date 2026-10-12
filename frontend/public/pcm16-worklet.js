
class Pcm16WorkletProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    const processorOptions = options.processorOptions || {};

    this.targetSampleRate =
      processorOptions.targetSampleRate || 16000;

    this.chunkSize = processorOptions.chunkSize || 1600;

    this.phase = 0;
    this.accumulator = 0;
    this.accumulatorCount = 0;

    this.outputBuffer = new Int16Array(this.chunkSize);
    this.outputIndex = 0;
  }

  process(inputs, outputs) {
    // Keep the output silent to prevent microphone feedback.
    for (const channel of outputs[0] || []) {
      channel.fill(0);
    }

    const input = inputs[0] && inputs[0][0];

    if (!input) {
      return true;
    }

    const sourceSampleRate = sampleRate;

    for (let i = 0; i < input.length; i++) {
      this.accumulator += input[i];
      this.accumulatorCount += 1;
      this.phase += this.targetSampleRate;

      if (this.phase >= sourceSampleRate) {
        this.phase -= sourceSampleRate;

        const average =
          this.accumulator / this.accumulatorCount;

        const clamped = Math.max(-1, Math.min(1, average));

        this.outputBuffer[this.outputIndex] =
          clamped < 0
            ? Math.round(clamped * 32768)
            : Math.round(clamped * 32767);

        this.outputIndex += 1;
        this.accumulator = 0;
        this.accumulatorCount = 0;

        if (this.outputIndex >= this.chunkSize) {
          const chunk = this.outputBuffer.slice();
          const transferableBuffer = chunk.buffer;

          this.port.postMessage(
            transferableBuffer,
            [transferableBuffer],
          );

          this.outputBuffer = new Int16Array(this.chunkSize);
          this.outputIndex = 0;
        }
      }
    }

    return true;
  }
}

registerProcessor("pcm16-worklet", Pcm16WorkletProcessor);
