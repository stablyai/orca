import type { Terminal } from '@xterm/xterm'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { resolveTerminalLigaturesEnabled } from '../../../../shared/terminal-ligatures'
import { TerminalLigaturesAddon } from '@/lib/pane-manager/terminal-ligatures-addon'

const ligatureAddonsByTerminal = new WeakMap<Terminal, TerminalLigaturesAddon>()

/**
 * Match the pane's ligature state on the preview terminal, attaching and
 * detaching as the setting (or a font that can't ligate) changes. The pane's
 * WebGL atlas rebuild has no counterpart here — the preview is DOM-rendered.
 */
export function syncPreviewTerminalLigatures(
  terminal: Terminal,
  settings: GlobalSettings | null
): void {
  const enabled = resolveTerminalLigaturesEnabled(
    settings?.terminalLigatures,
    settings?.terminalFontFamily
  )
  const attached = ligatureAddonsByTerminal.get(terminal)
  if (enabled === Boolean(attached)) {
    return
  }
  if (!enabled) {
    try {
      attached?.dispose()
    } catch {
      /* ignore */
    }
    ligatureAddonsByTerminal.delete(terminal)
    return
  }
  try {
    const addon = new TerminalLigaturesAddon()
    terminal.loadAddon(addon)
    ligatureAddonsByTerminal.set(terminal, addon)
    // Why: ligatures can turn on after rows rendered; force a glyph-run recompute.
    terminal.refresh(0, terminal.rows - 1)
  } catch {
    /* ignore: ligatures are cosmetic, never fail the preview over them */
  }
}
