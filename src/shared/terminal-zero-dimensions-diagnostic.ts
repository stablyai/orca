// Why: the zero-dimensions diagnostic is emitted by the renderer's PTY connect
// path and later cleared once a hidden pane becomes visible and refits. Keeping
// the message text and its matcher together lets both sites stay in sync.

export function createTerminalZeroDimensionsMessage(cols: number, rows: number): string {
  return `Terminal has zero dimensions (${cols}×${rows}). The pane container may not be visible.`
}

export function isTerminalZeroDimensionsDiagnostic(message: string): boolean {
  return message.startsWith('Terminal has zero dimensions (')
}
