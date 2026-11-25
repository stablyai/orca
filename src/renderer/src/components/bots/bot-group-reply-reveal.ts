import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { BotGroupRoomUnavailableError, openBotGroupRoom } from '@/lib/bot-group-catalog'
import { callBotGroupRpc } from '@/lib/bot-group-rpc'
import { botGroupCompletedReply, type BotGroup } from '../../../../shared/bots/bot-group'
import type { BotGroupTranscript } from '../../../../shared/bots/bot-group-transcript'
import { openNativeChatSubagent } from '../native-chat/subagents/native-chat-open-subagent'
import { flashRevealedRow } from './bots-sidebar-reveal-dom'
import type { BotGroupSession } from './BotGroupSessionReader'
import type { useBotGroupTranscript } from './use-bot-group-transcript'
import type { useBotTranscriptFollow } from './use-bot-transcript-follow'

export type BotGroupReplyPreview = NonNullable<BotGroup['replyPreviews']>[number]
export type BotGroupReplyReveal =
  | { kind: 'reply'; reply: BotGroupReplyPreview }
  | { kind: 'missing' }

const pending = new Map<string, BotGroupReplyReveal>()
const listeners = new Set<() => void>()
let press = 0

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function publish(): void {
  listeners.forEach((listener) => listener())
}

export function useBotGroupReplyReveal(tabId: string): BotGroupReplyReveal | null {
  const read = useCallback(() => pending.get(tabId) ?? null, [tabId])
  return useSyncExternalStore(subscribe, read, read)
}

export function finishBotGroupReplyReveal(tabId: string, request: BotGroupReplyReveal): void {
  if (pending.get(tabId) === request) {
    pending.delete(tabId)
    publish()
  }
}

export async function revealBotGroupReply(
  group: BotGroup,
  reply: BotGroupReplyPreview,
  onOpen: () => void
): Promise<void> {
  const selected = ++press
  try {
    const page = await callBotGroupRpc<BotGroupTranscript>(group, 'bots.groups.read', {
      groupId: group.id,
      beforeSequence: reply.sequence + 1
    })
    if (selected !== press) {
      return
    }
    const found = page.messages.some(
      (message) =>
        message.id === reply.messageId &&
        message.turns.some((turn) => turn.operationId === reply.operationId)
    )
    const tabId = await openBotGroupRoom(page.group, group.id, page.group.name)
    if (selected === press) {
      pending.set(tabId, found ? { kind: 'reply', reply } : { kind: 'missing' })
      publish()
      onOpen()
    }
  } catch (error) {
    if (
      selected === press &&
      !(error instanceof BotGroupRoomUnavailableError && error.userNotified)
    ) {
      toast.error(
        translate('bots.groups.openUnavailable', 'Could not open “{{name}}”.', { name: group.name })
      )
    }
  }
}

export function useBotGroupReplyJump({
  tabId,
  replyReveal,
  transcript,
  follow,
  sessions,
  error,
  visible
}: {
  tabId: string
  replyReveal: BotGroupReplyReveal | null
  transcript: ReturnType<typeof useBotGroupTranscript>
  follow: Pick<ReturnType<typeof useBotTranscriptFollow>, 'contentRef' | 'revealRow'>
  sessions: ReadonlyMap<string, BotGroupSession>
  error: string | null
  visible: boolean
}) {
  const [missingReply, setMissingReply] = useState(false)
  const { data, readForReveal, earlierSequence, loadEarlierPage } = transcript
  const { contentRef, revealRow } = follow
  const selectedReply = replyReveal?.kind === 'reply' ? replyReveal.reply : null
  const targetTurn = selectedReply
    ? data?.messages
        .find((message) => message.id === selectedReply.messageId)
        ?.turns.find((turn) => turn.operationId === selectedReply.operationId)
    : undefined
  const targetSession = targetTurn ? sessions.get(targetTurn.sessionId) : undefined
  useEffect(() => {
    if (!replyReveal || !visible) {
      return
    }
    const finish = (missing: boolean): void => {
      setMissingReply(missing)
      finishBotGroupReplyReveal(tabId, replyReveal)
    }
    if (!selectedReply) {
      finish(true)
      return
    }
    if (readForReveal !== replyReveal) {
      return
    }
    if (error) {
      finish(true)
      return
    }
    if (!targetTurn) {
      if (earlierSequence !== undefined && selectedReply.sequence < earlierSequence) {
        const read = new AbortController()
        void loadEarlierPage(read.signal).catch(() => {
          if (!read.signal.aborted) {
            finish(true)
          }
        })
        return () => read.abort()
      }
      finish(true)
      return
    }
    const operationId = targetTurn.operationId
    openNativeChatSubagent(`bot-group-turn:${operationId}`, null)
    const replyId =
      selectedReply.replyMessageId ??
      botGroupCompletedReply(
        targetTurn.frozenItems ??
          targetSession?.groupTurnItems(operationId, targetTurn.workerDispatchIds) ??
          []
      )?.messageId ??
      (targetTurn.answer ? `${operationId}:answer` : undefined)
    const frame = requestAnimationFrame(() => {
      const row = replyId
        ? contentRef.current?.querySelector<HTMLElement>(
            `[data-group-turn="${CSS.escape(operationId)}"] [data-native-chat-message-id="${CSS.escape(replyId)}"]`
          )
        : null
      if (row) {
        revealRow(row, 'instant')
        flashRevealedRow(row)
        finish(false)
      } else if (
        targetTurn.revoked ||
        targetTurn.frozenItems ||
        targetSession?.status === 'error' ||
        (targetSession?.readCurrent && !targetSession.hasOlder)
      ) {
        finish(true)
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [
    contentRef,
    earlierSequence,
    error,
    visible,
    loadEarlierPage,
    readForReveal,
    replyReveal,
    revealRow,
    selectedReply,
    tabId,
    targetSession,
    targetTurn
  ])
  return { missingReply, clearMissingReply: () => setMissingReply(false) }
}
