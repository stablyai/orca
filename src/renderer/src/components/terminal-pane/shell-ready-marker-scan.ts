const SHELL_READY_MARKER = '\x1b]777;orca-shell-ready'

export type ShellReadyMarkerScanState = {
  matchPos: number
  heldBytes: string
}

export function createShellReadyMarkerScanState(): ShellReadyMarkerScanState {
  return { matchPos: 0, heldBytes: '' }
}

export function scanForShellReadyMarker(
  state: ShellReadyMarkerScanState,
  data: string
): { output: string; matched: boolean } {
  let output = ''

  for (let i = 0; i < data.length; i += 1) {
    const ch = data[i] as string
    if (state.matchPos < SHELL_READY_MARKER.length) {
      if (ch === SHELL_READY_MARKER[state.matchPos]) {
        state.heldBytes += ch
        state.matchPos += 1
      } else {
        output += state.heldBytes
        state.heldBytes = ''
        state.matchPos = 0
        if (ch === SHELL_READY_MARKER[0]) {
          state.heldBytes = ch
          state.matchPos = 1
        } else {
          output += ch
        }
      }
    } else if (ch === '\x07') {
      const remaining = data.slice(i + 1)
      state.heldBytes = ''
      state.matchPos = 0
      return { output: output + remaining, matched: true }
    } else {
      output += state.heldBytes
      state.heldBytes = ''
      state.matchPos = 0
      if (ch === SHELL_READY_MARKER[0]) {
        state.heldBytes = ch
        state.matchPos = 1
      } else {
        output += ch
      }
    }
  }

  return { output, matched: false }
}
