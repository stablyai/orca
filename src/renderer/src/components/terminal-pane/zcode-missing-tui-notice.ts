import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

/** ZCode desktop bundles can pass version/doctor probes yet fail interactively; report main’s capability verdict before a dead pane misleads the user. */
export async function warnIfZCodeCannotOpenSession(): Promise<void> {
  // Advisory probe failures must never interrupt launch.
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
      // Deduplicate the notice across simultaneous ZCode launches.
      id: 'zcode-missing-tui',
      description: translate(
        'auto.components.terminal.pane.zcode.missing.tui.description',
        "Orca's hooks installed correctly — the zcode on your PATH just cannot open a session. The ZCode desktop app bundles the agent runtime without its terminal UI. Install a zcode that ships the TUI, then run zcode outside Orca to confirm."
      ),
      duration: 20_000
    }
  )
}
