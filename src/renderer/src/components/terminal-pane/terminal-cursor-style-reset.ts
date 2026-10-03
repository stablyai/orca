import type { Terminal } from '@xterm/xterm'

/** Reset DECSCUSR without interrupting a partially parsed PTY escape sequence. */
export function resetTerminalCursorStyle(
  terminal: Pick<Terminal, 'refresh' | 'buffer' | 'rows'>
): void {
  if (!('_core' in terminal)) {
    return
  }
  const core = terminal._core
  if (!core || typeof core !== 'object' || !('coreService' in core)) {
    return
  }
  const service = core.coreService
  if (!service || typeof service !== 'object' || !('decPrivateModes' in service)) {
    return
  }
  const modes = service.decPrivateModes
  if (
    !modes ||
    typeof modes !== 'object' ||
    !('cursorStyle' in modes) ||
    !('cursorBlink' in modes)
  ) {
    return
  }
  // Match xterm's CSI 0 SP q handler without feeding bytes to its parser.
  modes.cursorStyle = undefined
  modes.cursorBlink = undefined
  const buffer = terminal.buffer.active
  const row = buffer.baseY + buffer.cursorY - buffer.viewportY
  if (row >= 0 && row < terminal.rows) {
    terminal.refresh(row, row)
  }
}
