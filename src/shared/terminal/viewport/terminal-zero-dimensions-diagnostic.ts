// Keep connect-time diagnostics and reveal/refit clearing matched through the same message format.

export function createTerminalZeroDimensionsMessage(cols: number, rows: number): string {
  return `Terminal has zero dimensions (${cols}×${rows}). The pane container may not be visible.`
}

export function isTerminalZeroDimensionsDiagnostic(message: string): boolean {
  return message.startsWith('Terminal has zero dimensions (')
}
