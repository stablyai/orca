import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

/**
 * Tell the user their `zcode` cannot open a session, before they stare at a dead pane.
 *
 * ZCode's desktop bundle answers `--version`, runs `-p`, and passes `zcode doctor`, so Orca
 * detects it, launches it, and installs hooks against it — all successfully. Only the
 * interactive session fails, leaving a bare Node stack trace that reads as a broken Orca
 * integration. The capability probe in main answers the question; this reports it.
 */
export async function warnIfZCodeCannotOpenSession(): Promise<void> {
  // Why swallow: this is advisory. A probe that could not run must never interrupt a launch.
  const capability = await window.api.preflight.zcodeInteractiveCapability().catch(() => 'unknown')
  if (capability !== 'missing-tui') {
    return
  }
  toast.error(
    translate(
      'auto.components.terminal.pane.zcode.missing.tui.title',
      'This ZCode build has no terminal UI'
    ),
    {
      // Why a stable id: launching several ZCode panes must not stack the same notice.
      id: 'zcode-missing-tui',
      description: translate(
        'auto.components.terminal.pane.zcode.missing.tui.description',
        "Orca's hooks installed correctly — the zcode on your PATH just cannot open a session. The ZCode desktop app bundles the agent runtime without its terminal UI. Install a zcode that ships the TUI, then run zcode outside Orca to confirm."
      ),
      duration: 20_000
    }
  )
}
