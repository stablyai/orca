// Runs in AudioWorkletGlobalScope, off the renderer's main thread.
import { measureDictationAudioChunk } from '../../../../shared/dictation-audio-meter'
import { StreamingSincResampler } from '../../../../shared/streaming-sinc-resampler'
import {
  DICTATION_CAPTURE_WORKLET_NAME,
  type DictationCaptureWorkletMessage,
  type DictationCaptureWorkletOptions
} from './dictation-capture-worklet-protocol'

declare const sampleRate: number
declare class AudioWorkletProcessor {
  readonly port: MessagePort
}
declare function registerProcessor(
  name: string,
  processor: new (options: { processorOptions: DictationCaptureWorkletOptions }) => unknown
): void

class DictationCaptureProcessor extends AudioWorkletProcessor {
  private readonly resampler: StreamingSincResampler
  // The transfer detaches each sent frame, so its length can't be read back.
  private readonly frameSamples: number
  private frame: Float32Array
  private frameLength = 0
  // Measured at the device rate so clipping sees the samples before the low-pass.
  private readonly levelWindowSamples: number
  private levelSamples = 0
  private levelSumSquares = 0
  private levelPeak = 0

  constructor({ processorOptions }: { processorOptions: DictationCaptureWorkletOptions }) {
    super()
    this.resampler = new StreamingSincResampler(sampleRate, processorOptions.outputSampleRate)
    this.frameSamples = processorOptions.frameSamples
    this.frame = new Float32Array(this.frameSamples)
    this.levelWindowSamples = Math.round((sampleRate * processorOptions.levelWindowMs) / 1000)
  }

  process(inputs: Float32Array[][]): boolean {
    const channel = inputs[0]?.[0]
    if (channel) {
      this.measure(channel)
      this.appendToFrame(this.resampler.process(channel))
    }
    return true
  }

  private measure(block: Float32Array): void {
    const { rms, peak } = measureDictationAudioChunk(block)
    this.levelSamples += block.length
    this.levelSumSquares += rms * rms * block.length
    this.levelPeak = Math.max(this.levelPeak, peak)
    if (this.levelSamples < this.levelWindowSamples) {
      return
    }
    const message: DictationCaptureWorkletMessage = {
      type: 'level',
      rms: Math.sqrt(this.levelSumSquares / this.levelSamples),
      peak: this.levelPeak
    }
    this.port.postMessage(message)
    this.levelSamples = 0
    this.levelSumSquares = 0
    this.levelPeak = 0
  }

  private appendToFrame(samples: Float32Array): void {
    let offset = 0
    while (offset < samples.length) {
      const count = Math.min(samples.length - offset, this.frameSamples - this.frameLength)
      this.frame.set(samples.subarray(offset, offset + count), this.frameLength)
      this.frameLength += count
      offset += count
      if (this.frameLength === this.frameSamples) {
        const message: DictationCaptureWorkletMessage = { type: 'frame', samples: this.frame }
        this.port.postMessage(message, [this.frame.buffer])
        this.frame = new Float32Array(this.frameSamples)
        this.frameLength = 0
      }
    }
  }
}

registerProcessor(DICTATION_CAPTURE_WORKLET_NAME, DictationCaptureProcessor)
