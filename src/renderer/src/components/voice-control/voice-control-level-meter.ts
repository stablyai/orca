import { publishVoiceControlMicLevel, publishVoiceControlOutputLevel } from './voice-control-store'

/**
 * Renderer-local level meters for the control: an AnalyserNode on the given stream,
 * sampled on an animation frame. Deliberately separate from dictation's IPC-fed meter —
 * these streams never leave the renderer.
 */
function startLevelMeter(stream: MediaStream, publish: (level: number) => void): () => void {
  const context = new AudioContext()
  const source = context.createMediaStreamSource(stream)
  const analyser = context.createAnalyser()
  analyser.fftSize = 512
  source.connect(analyser)
  const samples = new Uint8Array(analyser.fftSize)
  let rafId = 0
  const tick = (): void => {
    analyser.getByteTimeDomainData(samples)
    let peak = 0
    for (const sample of samples) {
      peak = Math.max(peak, Math.abs(sample - 128) / 128)
    }
    publish(peak)
    rafId = requestAnimationFrame(tick)
  }
  rafId = requestAnimationFrame(tick)
  return () => {
    cancelAnimationFrame(rafId)
    source.disconnect()
    publish(0)
    void context.close()
  }
}

/** Mic level for the pill's live meter. */
export function startVoiceControlMicMeter(stream: MediaStream): () => void {
  return startLevelMeter(stream, publishVoiceControlMicLevel)
}

/** Coordinator voice level for the output waveform. */
export function startVoiceControlOutputMeter(stream: MediaStream): () => void {
  return startLevelMeter(stream, publishVoiceControlOutputLevel)
}
