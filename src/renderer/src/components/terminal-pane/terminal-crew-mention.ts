import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import {
  terminalAgentReference,
  type OrchestrationAgentReference
} from '../../../../shared/orchestration-agent-reference'
import {
  getCurrentTerminalDropTransport,
  type CapturedTerminalDropTarget
} from './terminal-drop-target'
import { writeTerminalPastePtyInput } from './terminal-pty-paste-writer'
import type { PtyTransport } from './pty-transport-types'

export async function insertTerminalCrewMention(
  manager: PaneManager,
  transports: Map<number, PtyTransport>,
  target: CapturedTerminalDropTarget,
  references: OrchestrationAgentReference[]
): Promise<boolean> {
  const parts = references.map(terminalAgentReference)
  if (parts.length === 0 || parts.some((part) => part === null)) {
    return false
  }
  const transport = getCurrentTerminalDropTransport(manager, transports, target)
  return transport ? await writeTerminalPastePtyInput(transport, parts.join(''), 'driving') : false
}
