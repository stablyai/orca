import type { Terminal } from '@xterm/xterm'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { activateOrcaTerminalUnicodeProvider } from '../../../../shared/terminal-unicode-provider'
import { installWindowsCtrlAltChordRepair } from '@/lib/pane-manager/terminal-windows-ctrl-alt-chord-classification'
import { attachTerminalMouseWheelMultiplier } from '@/lib/pane-manager/pane-terminal-mouse-wheel'
import { configureLazyArabicShapingJoiner } from '@/lib/pane-manager/terminal-arabic-shaping-joiner'
import { installTerminalImeCandidateAnchor } from '@/lib/pane-manager/terminal-ime-candidate-anchor'
import { normalizeTerminalTuiMouseWheelMultiplier } from '@/lib/pane-manager/pane-terminal-tui-wheel-reports'
import { installPreviewTerminalLinks } from './preview-terminal-links'
import { syncPreviewTerminalLigatures } from './preview-terminal-ligatures'

/** Match pane compatibility; dispose DOM bindings before replacing or disposing the terminal. */
export function installPreviewTerminalCompatibility(
  terminal: Terminal,
  deps: { getSettings: () => GlobalSettings | null }
): () => void {
  // Load Unicode 11 before its width shim and any replay; earlier writes bake wide characters into default v6 widths.
  terminal.loadAddon(new Unicode11Addon())
  activateOrcaTerminalUnicodeProvider(terminal)
  installWindowsCtrlAltChordRepair(terminal)
  installPreviewTerminalLinks(terminal)
  syncPreviewTerminalLigatures(terminal, deps.getSettings())
  attachTerminalMouseWheelMultiplier(terminal, {
    getTuiMouseWheelMultiplier: () =>
      normalizeTerminalTuiMouseWheelMultiplier(deps.getSettings()?.terminalTuiScrollSensitivity)
  })
  // Register Arabic joining only after RTL arrives; DOM previews need no WebGL atlas compensation.
  const disposeArabicShapingJoiner = configureLazyArabicShapingJoiner(terminal, () => false)
  const imeAnchorHandler = installTerminalImeCandidateAnchor(terminal)

  return () => {
    if (imeAnchorHandler && terminal.element) {
      terminal.element.removeEventListener('compositionstart', imeAnchorHandler)
      terminal.element.removeEventListener('compositionupdate', imeAnchorHandler)
    }
    disposeArabicShapingJoiner()
  }
}
