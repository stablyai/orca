import type { AgentJournalRenderItem } from '../journal/agent-session-journal-types'
import { isRootAgentJournalItem } from '../journal/agent-session-journal-producer'
import { rootAssistantProse } from './structured-agent-session-latest-request'
import { journalItemHasSideEffects } from './tool-call-side-effects'

/** What a turn's end tells the request it answered, in one pass over its rows. prose: its newest root
 *  prose. botProse: a bot's answer, its newest root prose after the root agent's last tool call (text
 *  before a call was commentary; a child's calls run beside the answer). toolsRan: work inside the
 *  turn, a child's included, may have changed something (journalItemHasSideEffects). */
export function structuredAgentSessionTurnReply(
  items: readonly AgentJournalRenderItem[],
  turnItemId: string
): { prose: string; botProse: string; toolsRan: boolean } {
  let prose = ''
  let botProse: string | null = null
  let toolsRan = false
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item?.turnScope?.kind !== 'turn' || item.turnScope.turnItemId !== turnItemId) {
      continue
    }
    toolsRan ||= journalItemHasSideEffects(item.body)
    // A file edit recorded as a diff ends the commentary before it, like any tool call.
    if (item.body.kind === 'tool-call' || item.body.kind === 'diff') {
      if (isRootAgentJournalItem(item)) {
        botProse ??= ''
      }
    } else if (!prose) {
      const said = rootAssistantProse(item)
      if (said.trim()) {
        prose = said
        botProse ??= said
      }
    }
    // Every answer is known: nothing earlier changes it.
    if (prose && botProse !== null && toolsRan) {
      break
    }
  }
  return { prose, botProse: botProse ?? '', toolsRan }
}
