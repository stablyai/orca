import { findBotByWorkspace } from '@/components/bots/bot-workspace'
import type { Bot } from '../../../../../shared/bot-types'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import type { ResumeCandidate } from '../tree/native-chat-resume-on-restart-grouping'

/** The bot whose chat a resumed row is, on that row's host only. */
export function resumeRowBot(
  bots: readonly Bot[],
  candidate: Pick<ResumeCandidate, 'workspaceId' | 'surface'>,
  hostId: ExecutionHostId
): Bot | null {
  // A terminal worker can run in a bot's folder without being one of its chats.
  return candidate.surface === 'terminal'
    ? null
    : findBotByWorkspace(bots, candidate.workspaceId, hostId)
}
