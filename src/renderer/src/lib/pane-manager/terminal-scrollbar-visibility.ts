import type { Terminal } from '@xterm/xterm'
import { normalizeTerminalScrollbarWidth } from '../../../../shared/terminal/appearance/terminal-scroll-settings'

const ALWAYS_VISIBLE_ATTRIBUTE = 'data-terminal-scrollbar-always-visible'

type AlwaysVisibleState = { enabled: boolean; container: HTMLElement }

const alwaysVisibleStates = new WeakMap<Terminal, AlwaysVisibleState>()

/** xterm hides an unneeded scrollbar with the same class as an idle one, so only force the bar on when it has history to scroll. */
export function terminalHasScrollableHistory(terminal: Pick<Terminal, 'buffer'>): boolean {
  const buffer = terminal.buffer.active
  return buffer.type === 'normal' && buffer.baseY > 0
}

function syncAlwaysVisibleAttribute(terminal: Terminal, state: AlwaysVisibleState): void {
  state.container.toggleAttribute(
    ALWAYS_VISIBLE_ATTRIBUTE,
    state.enabled && terminalHasScrollableHistory(terminal)
  )
}

/** Writes the width option only when it changes (a write refits the pane) and keeps the always-visible attribute in step with the buffer. */
export function applyTerminalScrollbarSettings(
  terminal: Terminal,
  container: HTMLElement,
  settings: { terminalScrollbarWidth?: number; terminalScrollbarAlwaysVisible?: boolean } | null
): void {
  const width = normalizeTerminalScrollbarWidth(settings?.terminalScrollbarWidth)
  if (terminal.options.scrollbar?.width !== width) {
    terminal.options.scrollbar = { ...terminal.options.scrollbar, width }
  }
  let state = alwaysVisibleStates.get(terminal)
  if (!state) {
    const created: AlwaysVisibleState = { enabled: false, container }
    state = created
    alwaysVisibleStates.set(terminal, created)
    const resync = (): void => syncAlwaysVisibleAttribute(terminal, created)
    // Scrollback appears, clears, or the alternate screen toggles/reflows without a settings change.
    terminal.onScroll(resync)
    terminal.onResize(resync)
    terminal.buffer.onBufferChange(resync)
    // Erasing the scrollback (`clear`, `Clear-Host`: ED 3) fires none of the events above. The
    // sync is a cheap comparison and toggleAttribute is a no-op when the value is unchanged.
    terminal.onWriteParsed(resync)
  }
  state.enabled = settings?.terminalScrollbarAlwaysVisible === true
  state.container = container
  syncAlwaysVisibleAttribute(terminal, state)
}
