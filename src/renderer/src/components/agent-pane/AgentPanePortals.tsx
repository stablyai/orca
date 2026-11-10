import { AgentSignInPanePortals } from '../agent-sign-in/AgentSignInPanePortals'
import type { TerminalPaneController } from '../terminal-pane/controller/use-terminal-pane-controller'
import { SecretRequestPanePortals } from './SecretRequestPanePortals'

/** Cards an agent's host can raise over its pane: sign-in (#40228) and secret requests (S4-b). */
export function AgentPanePortals({
  controller
}: {
  controller: TerminalPaneController
}): React.JSX.Element {
  return (
    <>
      <AgentSignInPanePortals controller={controller} />
      <SecretRequestPanePortals controller={controller} />
    </>
  )
}
