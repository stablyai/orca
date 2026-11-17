import { AgentSignInPanePortals } from '../agent-sign-in/AgentSignInPanePortals'
import {
  CloudAgentSignInStripPortals,
  useCloudGatePaneKeys
} from '../agent-sign-in-strip/CloudAgentSignInStripPortals'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import type { TerminalPaneController } from '../terminal-pane/controller/use-terminal-pane-controller'
import { SecretRequestPanePortals } from './SecretRequestPanePortals'

/**
 * Prompts an agent's host can raise over its pane: sign-in and secret requests. Orca Cloud
 * panes use the private sign-in strip; every other host keeps #40228's card.
 */
export function AgentPanePortals({
  controller
}: {
  controller: TerminalPaneController
}): React.JSX.Element {
  const cloudKeys = useCloudGatePaneKeys(controller)
  const hostPanes = {
    ...controller,
    managedPanes: controller.managedPanes.filter(
      (pane) => !cloudKeys.has(makePaneKey(controller.tabId, pane.leafId))
    )
  }
  return (
    <>
      <AgentSignInPanePortals controller={hostPanes} />
      <CloudAgentSignInStripPortals controller={controller} />
      <SecretRequestPanePortals controller={controller} />
    </>
  )
}
