const terminalBufferCaptures = new Set<() => void>()

export function registerTerminalBufferCapture(capture: () => void): () => void {
  terminalBufferCaptures.add(capture)
  return () => {
    terminalBufferCaptures.delete(capture)
  }
}

export function captureAllTerminalBuffers(): void {
  for (const capture of terminalBufferCaptures) {
    try {
      capture()
    } catch {
      // Why: split-layout transitions should still proceed even if one pane's
      // buffer snapshot fails. Best-effort capture is enough to keep the rest
      // of the workspace stable.
    }
  }
}
