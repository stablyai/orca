// One navigation at a time — a rail pick or a diff reveal — pinned until it lands; rail picks and a subagent view's history page through one cancellable history loop.

import { useCallback, useEffect, useRef, useState } from 'react'
import { latestAgentSessionContextClearSequence } from '../../../../../../shared/agent-session/agent-session-context-clear'
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
import { nativeChatSlotIndexOf } from '../../conversation/slots/native-chat-transcript-slot-selection'
import type { NativeChatTranscriptSlot } from '../../conversation/slots/native-chat-transcript-slots'
import { nativeChatRailJumpStep, useNativeChatHistoryJump } from './use-native-chat-history-jump'
import { useNativeChatRailJumpLanding } from './use-native-chat-rail-jump-landing'
import type { NativeChatAlignEdge } from '../virtualization/use-native-chat-viewport-align'

type NavigationRequest =
  | { kind: 'diff'; target: NativeChatDiffReveal }
  | { kind: 'rail'; messageId: string; requestId: number }

export type NativeChatNavigationRequest = {
  revealedDiff: NativeChatDiffReveal | null
  railJump: { messageId: string; requestId: number } | null
  /** The one slot the window keeps mounted until the request lands. */
  revealIndex: number
  issue: (request: NavigationRequest | null) => void
  nextRequestId: () => number
}

/** Read before the window mounts rows, so the request's slot stays drawn. */
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
  conversation,
  subagentRows,
  roster,
  journalItems,
  subagentId,
  sessionKey,
  isVisible,
  loadEarlier,
  holdHistory,
  scrollRef,
  scrollMessageToTop,
  readerLeavesEnd,
  scrollToBottom
}: {
  request: NativeChatNavigationRequest
  rail: { items: readonly NativeChatRailItem[]; onActivate: (id: string) => void }
  slots: readonly NativeChatTranscriptSlot[]
  conversation: readonly NativeChatMessage[]
  subagentRows: ReadonlyMap<string, readonly NativeChatSubagentRow[]>
  roster: StructuredAgentSubagentRoster | undefined
  journalItems: readonly AgentJournalRenderItem[] | undefined
  /** A subagent's view, which pages older history until the agent's spawn is loaded. */
  subagentId: string | null
  sessionKey: string
  isVisible: boolean
  loadEarlier: () => Promise<NativeChatOlderPageResult>
  /** Keeps paged history loaded while the reader stays at the end. */
  holdHistory: () => void
  scrollRef: React.RefObject<HTMLDivElement | null>
  scrollMessageToTop: (element: HTMLElement, edge?: NativeChatAlignEdge) => void
  readerLeavesEnd: () => void
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
      return step
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
  useEffect(() => {
    if (subagentId !== null && isVisible) {
      startHistoryJump({ kind: 'subagent', agentId: subagentId })
    }
  }, [isVisible, startHistoryJump, subagentId])
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
