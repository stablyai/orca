import type { ManagedPane } from '../../../lib/pane-manager/pane-manager-types'
import { copyAgentSessionContext } from '../../../lib/copy-agent-session-context'
import { translate } from '../../../i18n/i18n'

// Standalone Copy Context omits the dialog’s fork instructions so it can be pasted into another tool.
export async function copyAgentSessionContextFromPane(pane: ManagedPane): Promise<boolean> {
  return copyAgentSessionContext(
    pane.serializeAddon.serialize({ scrollback: 800 }),
    () => pane.terminal.focus(),
    translate(
      'auto.components.terminal.pane.terminal.agent.session.fork.f62b40e2c7',
      'No terminal context to copy'
    )
  )
}
