// A shared agent's chat opens in a tab this computer keeps in the agent's home here, and reaches the
// chat on its owner's computer: that host lists none of its tabs or workspaces to a share.
import { botOfHomeWorkspace } from '../../../../../shared/bots/bot-homes'
import { useAppStore } from '@/store'
import { sharedBotHostOf } from '@/runtime/hosts/shared-bot-hosts/shared-bot-host-catalog'
import { readBots } from '../../bot-catalog-snapshot'
import { activateAndRevealWorktree } from '../../workspace/activation/worktree-activation'
import { openStructuredAgentSessionProvisionalTab } from '../launch/structured-agent-session-launch-surface'

/** Null when `workspaceId` is no shared agent's home; else whether the chat's tab opened. */
export function openSharedBotChat(structuredSession: {
  workspaceId: string
  sessionId: string
}): boolean | null {
  const { workspaceId, sessionId } = structuredSession
  const bot = botOfHomeWorkspace(readBots(), workspaceId)
  if (!bot || !sharedBotHostOf(bot.hostId)) {
    return null
  }
  // The chat's tab below is the surface.
  if (activateAndRevealWorktree(workspaceId, { providesInitialSurface: true }) === false) {
    return false
  }
  openStructuredAgentSessionProvisionalTab({
    worktreeId: workspaceId,
    executionHostId: bot.hostId,
    sessionId,
    agent: bot.agent
  })
  return true
}

/** Null when `workspaceId` is no shared agent's home; else closes the chat's tabs kept here, as its
 *  host closes its own tabs of a chat it retired (a replaced Home Chat). */
export function closeSharedBotChat(structuredSession: {
  workspaceId: string
  sessionId: string
}): boolean | null {
  const { workspaceId, sessionId } = structuredSession
  const bot = botOfHomeWorkspace(readBots(), workspaceId)
  if (!bot || !sharedBotHostOf(bot.hostId)) {
    return null
  }
  const state = useAppStore.getState()
  const kept = (state.unifiedTabsByWorktree[workspaceId] ?? []).filter(
    (tab) => tab.contentType === 'agent-session' && tab.entityId === sessionId
  )
  for (const tab of kept) {
    state.closeUnifiedTab(tab.id)
  }
  return kept.length > 0
}
