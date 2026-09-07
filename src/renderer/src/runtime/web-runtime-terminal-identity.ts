import { parsePaneKey } from '../../../shared/stable-pane-id'
import type { CreatedAgentTerminalIdentity } from './web-runtime-session-types'

export function createdTerminalLeafId(terminal: CreatedAgentTerminalIdentity): string | undefined {
  const pane = parsePaneKey(terminal.paneKey ?? '')
  return pane && pane.tabId === terminal.tabId ? pane.leafId : undefined
}
