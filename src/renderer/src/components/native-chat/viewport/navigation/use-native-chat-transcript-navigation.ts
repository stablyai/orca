import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import {
  useBotLinkItemTarget,
  consumeBotLinkItem
} from '@/lib/agent-session/open/bot-link-item-target'
// One navigation at a time — a rail pick or a diff reveal — pinned until it lands; rail picks and a subagent view's history page through one cancellable history loop.

import { useCallback, useEffect, useRef, useState } from 'react'
import { latestAgentSessionContextClearSequence } from '../../../../../../shared/agent-session/conversation-context/agent-session-context-clear'
import type { AgentJournalRenderItem } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { StructuredAgentSubagentRoster } from '../../../../../../shared/agent-session/view/structured-agent-session-subagent-roster'
import type {
  NativeChatDiffReveal,
  NativeChatDiffTarget
} from '../../../../../../shared/native-chat/tools/native-chat-turn-diffs'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import type { NativeChatSubagentRow } from '../../../../../../shared/native-chat/transcript/native-chat-transcript-projection'
import type { NativeChatRailItem } from '../rail/native-chat-message-rail-items'
import type { NativeChatOlderPageResult } from '../history/native-chat-pagination'
import { nativeChatSubagentHistoryStep } from '../../subagents/native-chat-subagent-history'
import {
  nativeChatSlotIndexOf,
  nativeChatSlotKeyAt
} from '../../conversation/slots/native-chat-transcript-slot-selection'
import type { NativeChatTranscriptSlot } from '../../conversation/slots/native-chat-transcript-slots'
import { nativeChatRailJumpStep, useNativeChatHistoryJump } from './use-native-chat-history-jump'
import { useNativeChatRailJumpLanding } from './use-native-chat-rail-jump-landing'
import { useNativeChatReadingPosition } from './use-native-chat-reading-position'
import type { NativeChatAlignEdge } from '../virtualization/use-native-chat-viewport-align'

type NavigationRequest =
  | { kind: 'diff'; target: NativeChatDiffReveal }
  | { kind: 'rail'; messageId: string; requestId: number; fromLink?: true; offset?: number }

export type NativeChatNavigationRequest = {
  revealedDiff: NativeChatDiffReveal | null
  railJump: { messageId: string; requestId: number; fromLink?: true; offset?: number } | null
  /** The one slot the window keeps mounted until the request lands. */
  revealIndex: number
  issue: (request: NavigationRequest | null) => void
  nextRequestId: () => number
}

/** Read before the window mounts rows, so the request's slot stays drawn. */
/** A waiting message's drawn row: those rows sit after the window, unindexed. */
function waitingRowOf(
  container: HTMLElement | null,
  waitingSlots: readonly NativeChatTranscriptSlot[],
  messageId: string
): HTMLElement | null {
  const index = waitingSlots.findIndex(
    (_, at) => nativeChatSlotKeyAt(waitingSlots, at) === messageId
  )
  return index < 0
    ? null
    : (container?.querySelector<HTMLElement>(`[data-native-chat-waiting-index="${index}"]`) ?? null)
}

export function useNativeChatNavigationRequest(
  slots: readonly NativeChatTranscriptSlot[]
): NativeChatNavigationRequest {
  const [request, issue] = useState<NavigationRequest | null>(null)
  const sequence = useRef(0)
  const nextRequestId = useCallback(() => {
    sequence.current += 1
    return sequence.current
  }, [])
  const revealedDiff = request?.kind === 'diff' ? request.target : null
  const railJump = request?.kind === 'rail' ? request : null
  const revealIndex = nativeChatSlotIndexOf(slots, railJump?.messageId ?? revealedDiff?.messageId)
  return {
    revealedDiff,
    railJump,
    revealIndex,
    issue,
    nextRequestId
  }
}

export function useNativeChatNavigation({
  request,
  rail,
  slots,
  waitingSlots,
  conversation,
  subagentRows,
  roster,
  journalItems,
  subagentId,
  sessionKey,
  transcriptKey,
  sessionId,
  ready = true,
  isVisible,
  loadEarlier,
  holdHistory,
  releaseHistory,
  scrollRef,
  scrollMessageToTop,
  readerLeavesEnd,
  readerAtEnd,
  scrollToBottom
}: {
  request: NativeChatNavigationRequest
  rail: { items: readonly NativeChatRailItem[]; onActivate: (id: string) => void }
  slots: readonly NativeChatTranscriptSlot[]
  /** Rows held behind the running turn, drawn after the window. */
  waitingSlots: readonly NativeChatTranscriptSlot[]
  conversation: readonly NativeChatMessage[]
  subagentRows: ReadonlyMap<string, readonly NativeChatSubagentRow[]>
  roster: StructuredAgentSubagentRoster | undefined
  journalItems: readonly AgentJournalRenderItem[] | undefined
  /** A subagent's view, which pages older history until the agent's spawn is loaded. */
  subagentId: string | null
  sessionKey: string
  /** This transcript within its chat tab: session, subagent and conversation. */
  transcriptKey: string
  sessionId?: string | null
  ready?: boolean
  isVisible: boolean
  loadEarlier: () => Promise<NativeChatOlderPageResult>
  /** Keeps paged history loaded while the reader stays at the end. */
  holdHistory: () => void
  releaseHistory: () => void
  scrollRef: React.RefObject<HTMLDivElement | null>
  scrollMessageToTop: (element: HTMLElement, edge?: NativeChatAlignEdge, inset?: number) => void
  readerLeavesEnd: () => void
  readerAtEnd: () => boolean
  scrollToBottom: () => void
}) {
  const { issue, nextRequestId } = request
  const requestRailJump = useCallback(
    (item: NativeChatRailItem) => {
      issue({ kind: 'rail', messageId: item.id, requestId: nextRequestId() })
    },
    [issue, nextRequestId]
  )
  const historyJump = useNativeChatHistoryJump({
    step: (target) => {
      if (target.kind === 'item') {
        const pending = journalItems?.find((item) => item.itemId === target.id)?.body
        if (
          (pending?.kind === 'approval' || pending?.kind === 'question') &&
          pending.resolution.state === 'pending'
        ) {
          return 'landed'
        }
        const index = nativeChatSlotIndexOf(slots, target.id)
        const waiting =
          index < 0 && target.offset !== undefined
            ? waitingRowOf(scrollRef.current, waitingSlots, target.id)
            : null
        if (waiting) {
          readerLeavesEnd()
          scrollMessageToTop(waiting, 'start', target.offset)
          return 'landed'
        }
        // A returning reader's row inside a collapsed turn is loaded but drawn by nothing; don't page for it.
        if (
          index < 0 &&
          target.offset !== undefined &&
          conversation.some((message) => message.id === target.id)
        ) {
          return 'stop'
        }
        if (index < 0) {
          holdHistory()
          return 'page'
        }
        issue({
          kind: 'rail',
          messageId: target.id,
          requestId: nextRequestId(),
          fromLink: true,
          offset: target.offset
        })
        return 'landed'
      }
      if (target.kind === 'rail') {
        return nativeChatRailJumpStep(rail.items, target.id, requestRailJump)
      }
      const step = nativeChatSubagentHistoryStep({
        agentId: target.agentId,
        conversation,
        subagentRows,
        roster,
        // The transcript starts at its latest /clear divider; scanned only when a page is in question.
        historyFloor: () => latestAgentSessionContextClearSequence(journalItems ?? [])
      })
      if (step === 'page') {
        holdHistory()
      }
      return step === 'cleared' ? 'stop' : step
    },
    sessionKey,
    isVisible,
    loadEarlier
  })
  const { start: startHistoryJump, abort: beginNavigation } = historyJump
  // Abort paging navigation before any new jump so late history cannot pull the reader back.
  const selectRailItem = useCallback(
    (item: NativeChatRailItem) => {
      beginNavigation()
      readerLeavesEnd()
      if (item.slotIndex === null) {
        startHistoryJump({ kind: 'rail', id: item.id })
        return
      }
      requestRailJump(item)
    },
    [beginNavigation, readerLeavesEnd, requestRailJump, startHistoryJump]
  )
  const revealDiff = useCallback(
    (target: NativeChatDiffTarget) => {
      beginNavigation()
      readerLeavesEnd()
      issue({ kind: 'diff', target: { ...target, requestId: nextRequestId() } })
    },
    [beginNavigation, issue, nextRequestId, readerLeavesEnd]
  )
  const restoring = useNativeChatReadingPosition({
    positionKey: transcriptKey,
    isVisible,
    ready,
    scrollRef,
    readerAtEnd,
    messageIdAt: (index) => nativeChatSlotKeyAt(slots, index),
    waitingMessageIdAt: (index) => nativeChatSlotKeyAt(waitingSlots, index),
    jumpTo: ({ messageId, offset }, settled) =>
      startHistoryJump({ kind: 'item', id: messageId, offset }, (result) => {
        if (result === 'missing' || result === 'failed') {
          releaseHistory()
          if (subagentId === null) {
            scrollToBottom()
          } else {
            startHistoryJump({ kind: 'subagent', agentId: subagentId })
          }
        }
        settled(result)
      })
  })
  useEffect(() => {
    // A returning reader's own row lies past the subagent's spawn, so its restore pages far enough.
    if (subagentId !== null && isVisible && !restoring()) {
      startHistoryJump({ kind: 'subagent', agentId: subagentId })
    }
  }, [isVisible, restoring, startHistoryJump, subagentId])
  const linkTarget = useBotLinkItemTarget((state) => state.target)
  useEffect(() => {
    if (isVisible && ready && linkTarget && linkTarget.sessionId === sessionId) {
      const itemId = linkTarget.itemId
      if (itemId === undefined) {
        consumeBotLinkItem(linkTarget)
        beginNavigation()
        scrollToBottom()
        return
      }
      startHistoryJump({ kind: 'item', id: itemId }, (result) => {
        if (useBotLinkItemTarget.getState().target !== linkTarget) {
          return
        }
        consumeBotLinkItem(linkTarget)
        if (result === 'missing' || result === 'failed') {
          releaseHistory()
          scrollToBottom()
          toast.info(translate('nativeChat.linkedMessageMissing', "Couldn't find that message."))
        }
      })
    }
  }, [
    isVisible,
    ready,
    linkTarget,
    sessionId,
    startHistoryJump,
    beginNavigation,
    releaseHistory,
    scrollToBottom
  ])
  const jumpToLatest = useCallback(() => {
    beginNavigation()
    scrollToBottom()
  }, [beginNavigation, scrollToBottom])
  useNativeChatRailJumpLanding({
    railJump: request.railJump,
    slots,
    scrollRef,
    scrollMessageToTop,
    onActivate: rail.onActivate,
    onScroll: request.railJump?.fromLink ? readerLeavesEnd : undefined,
    release: issue
  })
  return {
    beginNavigation,
    selectRailItem,
    revealDiff,
    jumpToLatest,
    pendingRailId: historyJump.pending?.kind === 'rail' ? historyJump.pending.id : null
  }
}
