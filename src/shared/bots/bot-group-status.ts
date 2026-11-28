import type { AgentStatusEntry } from '../agent-status/contracts/agent-status-types'
import { isAgentStatusFresh } from '../agent-status/contracts/agent-status-freshness'
import {
  applyAgentPaneActivityFlags,
  createAgentPaneActivityFlags,
  type WorktreeStatus
} from '../worktree/row-display/worktree-status-rollup'
import type { BotGroup } from './bot-group-schema'
import { botGroupRoomMembers } from './bot-group'
import { chatPaneKey } from '../agent-session/view/structured-agent-session-projection'

type BotGroupDot = Extract<WorktreeStatus, 'permission' | 'working'> | null
type MemberStatus = Parameters<typeof applyAgentPaneActivityFlags>[1]

/** A group's dot from its members' sessions in every room it has, the original and each thread;
 *  their Homes and workspaces never count. */
export function botGroupStatus(
  group: Pick<BotGroup, 'members' | 'threads'>,
  statusByPaneKey: Pick<ReadonlyMap<string, AgentStatusEntry>, 'get'>,
  now: number
): BotGroupDot {
  return botGroupStatusOf(group, (paneKey) => {
    const entry = statusByPaneKey.get(paneKey)
    return entry && isAgentStatusFresh(entry, now) ? entry : undefined
  })
}

/** The same dot from any reader's live member statuses; a phone reads them off the host's rows. */
export function botGroupStatusOf(
  group: Pick<BotGroup, 'members' | 'threads'>,
  statusOf: (paneKey: string) => MemberStatus | undefined
): BotGroupDot {
  const flags = createAgentPaneActivityFlags()
  for (const { sessionId } of botGroupRoomMembers(group).flat()) {
    const entry = statusOf(chatPaneKey(sessionId))
    if (entry) {
      applyAgentPaneActivityFlags(flags, entry)
    }
  }
  // Needs-you beats any member's live work; the sidebar ranking puts unconfirmed below working.
  if (flags.hasPermission || flags.hasFailed || flags.hasUnconfirmed) {
    return 'permission'
  }
  return flags.hasLiveWorking || flags.hasLiveMonitoring ? 'working' : null
}
