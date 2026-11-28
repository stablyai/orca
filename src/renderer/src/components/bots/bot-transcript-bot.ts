// The bot a chat transcript belongs to, from the transcript's own host and session, never from
// whichever workspace is active.
import { useBots, useBotsEnabled } from '@/lib/bot-catalog'
import type { RuntimeClientTarget } from '../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { Bot } from '../../../../shared/bot-types'
import { findBotByWorkspace } from './bot-workspace'
import { getRuntimeTargetHostId } from '@/runtime/rpc/targets/runtime-client-target'

export type TranscriptOwner = { target: RuntimeClientTarget; sessionId: string; worktreeId: string }

const sessionIndexes = new WeakMap<readonly Bot[], Map<string, Bot>>()

function sessionIndex(bots: readonly Bot[]): Map<string, Bot> {
  let index = sessionIndexes.get(bots)
  if (!index) {
    index = new Map()
    for (const bot of bots) {
      if (bot.chatSessionId) {
        const key = `${bot.hostId}\0${bot.chatSessionId}`
        if (!index.has(key)) {
          index.set(key, bot)
        }
      }
    }
    sessionIndexes.set(bots, index)
  }
  return index
}

export function transcriptBot(bots: readonly Bot[], owner: TranscriptOwner | null): Bot | null {
  if (!owner) {
    return null
  }
  const hostId = getRuntimeTargetHostId(owner.target)
  return (
    sessionIndex(bots).get(`${hostId}\0${owner.sessionId}`) ??
    findBotByWorkspace(bots, owner.worktreeId, hostId)
  )
}

export function useTranscriptBot(owner: TranscriptOwner | null): Bot | null {
  const bots = useBots(useBotsEnabled() && owner !== null)
  return transcriptBot(bots, owner)
}
