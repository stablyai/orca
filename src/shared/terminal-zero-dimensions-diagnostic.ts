export function createTerminalZeroDimensionsMessage(cols: number, rows: number): string {
  return `Terminal has zero dimensions (${cols}×${rows}). The pane container may not be visible.`
}
