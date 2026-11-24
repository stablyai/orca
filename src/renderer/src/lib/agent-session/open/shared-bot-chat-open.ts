// A shared agent's chat opens in a tab this computer keeps in the agent's home here, and reaches the
// chat on its owner's computer: that host lists none of its tabs or workspaces to a share.
import { botOfHomeWorkspace } from '../../../../../shared/bots/bot-homes'
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
  if (activateAndRevealWorktree(workspaceId) === false) {
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
