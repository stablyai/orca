import type { Terminal } from '@xterm/xterm'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { resolveTerminalLigaturesEnabled } from '../../../../shared/terminal-ligatures'
import { TerminalLigaturesAddon } from '@/lib/pane-manager/terminal-ligatures-addon'
import { TerminalContextualShapingAddon } from '@/lib/pane-manager/terminal-contextual-shaping-addon'

const ligatureAddonsByTerminal = new WeakMap<
  Terminal,
  { ligatures: TerminalLigaturesAddon; shaping: TerminalContextualShapingAddon }
>()

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
      attached?.ligatures.dispose()
      attached?.shaping.dispose()
    } catch {
      /* ignore */
    }
    ligatureAddonsByTerminal.delete(terminal)
    return
  }
  try {
    const ligatures = new TerminalLigaturesAddon()
    terminal.loadAddon(ligatures)
    // Why: match the pane — Fast-family fonts need whole-word shaping runs.
    const shaping = new TerminalContextualShapingAddon()
    terminal.loadAddon(shaping)
    ligatureAddonsByTerminal.set(terminal, { ligatures, shaping })
    // Why: ligatures can turn on after rows rendered; force a glyph-run recompute.
    terminal.refresh(0, terminal.rows - 1)
  } catch {
    /* ignore: ligatures are cosmetic, never fail the preview over them */
  }
}
