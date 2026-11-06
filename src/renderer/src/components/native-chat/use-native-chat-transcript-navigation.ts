// One navigation at a time — a rail pick, a diff reveal or a subagent named by the agents strip — pinned until it lands; rail picks and subagent reveals page through one cancellable history loop.

import { useCallback, useRef, useState } from 'react'
import { latestAgentSessionContextClearSequence } from '../../../../shared/agent-session/agent-session-context-clear'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { StructuredAgentSubagentRoster } from '../../../../shared/agent-session/view/structured-agent-session-subagent-roster'
import type {
  NativeChatDiffReveal,
  NativeChatDiffTarget
} from '../../../../shared/native-chat/tools/native-chat-turn-diffs'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'
import type { NativeChatRailItem } from './native-chat-message-rail-items'
import type { NativeChatOlderPageResult } from './native-chat-pagination'
import {
  nativeChatSubagentLanding,
  nativeChatSubagentPlace,
  useNativeChatSubagentLanding,
  type NativeChatSubagentLanding
} from './native-chat-subagent-reveal'
import type {
  NativeChatSubagentDisclosure,
  NativeChatSubagentSections
} from './native-chat-subagent-sections'
import {
  nativeChatSlotIndexOf,
  type NativeChatTranscriptSlot
} from './native-chat-transcript-slots'
import { nativeChatRailJumpStep, useNativeChatHistoryJump } from './use-native-chat-history-jump'
import { useNativeChatRailJumpLanding } from './use-native-chat-rail-jump-landing'
import type { NativeChatAlignEdge } from './use-native-chat-viewport-align'

type NavigationRequest =
  | { kind: 'diff'; target: NativeChatDiffReveal }
  | { kind: 'rail'; messageId: string; requestId: number }
  | { kind: 'subagent'; agentId: string; requestId: number }

export type NativeChatNavigationRequest = {
  revealedDiff: NativeChatDiffReveal | null
  railJump: { messageId: string; requestId: number } | null
  subagentJump: { agentId: string; requestId: number } | null
  subagentLanding: NativeChatSubagentLanding | null
  /** The one slot the window keeps mounted until the request lands. */
  revealIndex: number
  issue: (request: NavigationRequest | null) => void
  nextRequestId: () => number
}

/** Read before the window mounts rows, so the request's slot stays drawn. */
export function useNativeChatNavigationRequest(
  slots: readonly NativeChatTranscriptSlot[],
  conversation: readonly NativeChatMessage[],
  sections: NativeChatSubagentSections
): NativeChatNavigationRequest {
  const [request, issue] = useState<NavigationRequest | null>(null)
  const sequence = useRef(0)
  const nextRequestId = useCallback(() => {
    sequence.current += 1
    return sequence.current
  }, [])
  const revealedDiff = request?.kind === 'diff' ? request.target : null
  const railJump = request?.kind === 'rail' ? request : null
  const subagentJump = request?.kind === 'subagent' ? request : null
  const subagentLanding = subagentJump
    ? nativeChatSubagentLanding(slots, conversation, sections, subagentJump.agentId)
    : null
  const revealIndex =
    subagentLanding?.index ??
    nativeChatSlotIndexOf(slots, railJump?.messageId ?? revealedDiff?.messageId)
  return {
    revealedDiff,
    railJump,
    subagentJump,
    subagentLanding,
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
  sections,
  roster,
  journalItems,
  openSubagentSections,
  subagentDisclosure,
  sessionKey,
  isVisible,
  loadEarlier,
  scrollRef,
  scrollMessageToTop,
  readerLeavesEnd,
  scrollToBottom
}: {
  request: NativeChatNavigationRequest
  rail: { items: readonly NativeChatRailItem[]; onActivate: (id: string) => void }
  slots: readonly NativeChatTranscriptSlot[]
  conversation: readonly NativeChatMessage[]
  sections: NativeChatSubagentSections
  roster: StructuredAgentSubagentRoster | undefined
  journalItems: readonly AgentJournalRenderItem[] | undefined
  openSubagentSections: (agentIds: readonly string[]) => void
  subagentDisclosure: NativeChatSubagentDisclosure
  sessionKey: string
  isVisible: boolean
  loadEarlier: () => Promise<NativeChatOlderPageResult>
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
    step: (target, waited) => {
      if (target.kind === 'rail') {
        return nativeChatRailJumpStep(rail.items, target.id, requestRailJump)
      }
      const place = nativeChatSubagentPlace({
        agentId: target.agentId,
        conversation,
        sections,
        roster,
        slots,
        // The transcript starts at its latest /clear divider; scanned only when a page is in question.
        historyFloor: () => latestAgentSessionContextClearSequence(journalItems ?? [])
      })
      if (place.kind !== 'open') {
        return place.kind
      }
      if (waited === 0) {
        openSubagentSections(place.agentIds)
        if (place.rosterRowId !== undefined) {
          subagentDisclosure.setRosterOpen(place.rosterRowId, true)
        }
        return 'commit'
      }
      issue({ kind: 'subagent', agentId: target.agentId, requestId: nextRequestId() })
      return 'landed'
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
      if (target.subagentSections) {
        openSubagentSections(target.subagentSections)
      }
      issue({ kind: 'diff', target: { ...target, requestId: nextRequestId() } })
    },
    [beginNavigation, issue, nextRequestId, readerLeavesEnd, openSubagentSections]
  )
  const revealSubagent = useCallback(
    (agentId: string) => {
      beginNavigation()
      readerLeavesEnd()
      startHistoryJump({ kind: 'subagent', agentId })
    },
    [beginNavigation, readerLeavesEnd, startHistoryJump]
  )
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
  useNativeChatSubagentLanding({
    request: request.subagentJump,
    landing: request.subagentLanding,
    scrollRef,
    scrollMessageToTop,
    release: issue
  })
  return {
    beginNavigation,
    selectRailItem,
    revealDiff,
    revealSubagent,
    jumpToLatest,
    pendingRailId: historyJump.pending?.kind === 'rail' ? historyJump.pending.id : null
  }
}
