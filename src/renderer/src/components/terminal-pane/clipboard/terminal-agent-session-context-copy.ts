import type { ManagedPane } from '../../../lib/pane-manager/pane-manager-types'
import { copyAgentSessionContext } from '../../../lib/copy-agent-session-context'
import { translate } from '../../../i18n/i18n'
import { DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT } from '../../../../../shared/terminal/replay/terminal-scrollback-policy'

// Why: standalone Copy Context is pasted into another tool, so it uses the pane
// scrollback and the full cleaned transcript. Native chat keeps the char budget.
export async function copyAgentSessionContextFromPane(pane: ManagedPane): Promise<boolean> {
  const configured = pane.terminal.options.scrollback
  const scrollbackRows =
    typeof configured === 'number' && Number.isFinite(configured)
      ? Math.max(1, Math.floor(configured))
      : DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT
  return copyAgentSessionContext(
    pane.serializeAddon.serialize({ scrollback: scrollbackRows }),
    () => pane.terminal.focus(),
    translate(
      'auto.components.terminal.pane.terminal.agent.session.fork.f62b40e2c7',
      'No terminal context to copy'
    ),
    { full: true }
  )
}
