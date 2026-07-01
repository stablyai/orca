export type ShutdownBufferCaptureGate = {
  canCapture: () => boolean
  markCaptured: () => void
  reset: () => void
}

export function createShutdownBufferCaptureGate(): ShutdownBufferCaptureGate {
  let captured = false
  return {
    canCapture: () => !captured,
    markCaptured: () => {
      captured = true
    },
    reset: () => {
      captured = false
    }
  }
}
