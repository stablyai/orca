// The bot a chat transcript belongs to, from the transcript's own host and session, never from
// whichever workspace is active.
import { useBots, useBotsEnabled } from '@/lib/bot-catalog'
import type { RuntimeClientTarget } from '../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { Bot } from '../../../../shared/bot-types'
import { botOfHomeWorkspace } from '../../../../shared/bots/bot-homes'
import { getRuntimeTargetHostId } from '@/runtime/rpc/targets/runtime-client-target'

export type TranscriptOwner = { target: RuntimeClientTarget; sessionId: string; worktreeId: string }

export function transcriptBot(bots: readonly Bot[], owner: TranscriptOwner | null): Bot | null {
  if (!owner) {
    return null
  }
  const hostId = getRuntimeTargetHostId(owner.target)
  const onHost = bots.filter((bot) => bot.hostId === hostId)
  return (
    onHost.find((bot) => bot.chatSessionId === owner.sessionId) ??
    botOfHomeWorkspace(onHost, owner.worktreeId) ??
    null
  )
}

export function useTranscriptBot(owner: TranscriptOwner | null): Bot | null {
  const bots = useBots(useBotsEnabled() && owner !== null)
  return transcriptBot(bots, owner)
}
