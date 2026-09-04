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
  // Hoisted so the failure path can dispose addons that loaded before the
  // failure: a half-attached pair leaves an active joiner on the terminal,
  // and a retry would then stack a duplicate joiner.
  let ligatures: TerminalLigaturesAddon | null = null
  let shaping: TerminalContextualShapingAddon | null = null
  try {
    ligatures = new TerminalLigaturesAddon()
    terminal.loadAddon(ligatures)
    // Why: match the pane — Fast-family fonts need whole-word shaping runs.
    shaping = new TerminalContextualShapingAddon()
    terminal.loadAddon(shaping)
    ligatureAddonsByTerminal.set(terminal, { ligatures, shaping })
    // Why: ligatures can turn on after rows rendered; force a glyph-run recompute.
    terminal.refresh(0, terminal.rows - 1)
  } catch {
    // Roll back in reverse registration order, then forget the entry, so a
    // later sync can retry without stacking duplicate joiners. Ligatures are
    // cosmetic: never fail the preview over them.
    try {
      shaping?.dispose()
    } catch {
      /* ignore */
    }
    try {
      ligatures?.dispose()
    } catch {
      /* ignore */
    }
    ligatureAddonsByTerminal.delete(terminal)
  }
}
