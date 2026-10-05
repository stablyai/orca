import { useLayoutEffect } from 'react'
import { useAppStore } from '@/store'
import { nativeChatRowRendersContent } from '../../../../shared/native-chat-row-content'
import type { NativeChatSubagentSections } from './native-chat-subagent-sections'

/** The row a reveal of `agentId` lands on, and the sections to open so it draws: its first row
 *  with content. Null when the loaded transcript holds none for it. */
export function nativeChatSubagentRevealTarget(
  sections: NativeChatSubagentSections,
  agentId: string
): { messageId: string; openSections: readonly string[] } | null {
  const row = sections.rows
    .get(agentId)
    ?.find((candidate) => nativeChatRowRendersContent(candidate.message.blocks))
  if (!row) {
    return null
  }
  return {
    messageId: row.message.id,
    openSections: sections.pathOf.get(row.message.id) ?? [agentId]
  }
}

/** Serves a sidebar subagent row's request to show that subagent in this chat: opens its section
 *  and jumps to its first row. One-shot — a subagent with no loaded rows leaves the chat where the
 *  activation put it, rather than scrolling the reader later when rows arrive. */
export function useNativeChatSubagentRevealRequest({
  paneKey,
  ready,
  sections,
  openSubagentSections,
  beginNavigation,
  requestJump
}: {
  paneKey: string | undefined
  /** The transcript is loaded and on screen, so a miss is a real miss. */
  ready: boolean
  sections: NativeChatSubagentSections
  openSubagentSections: (agentIds: readonly string[]) => void
  /** Aborts navigation already under way, as every reader-driven jump does. */
  beginNavigation: () => void
  requestJump: (target: { id: string }) => void
}): void {
  const request = useAppStore((s) =>
    paneKey !== undefined && s.pendingNativeChatSubagentReveal?.parentPaneKey === paneKey
      ? s.pendingNativeChatSubagentReveal
      : null
  )
  useLayoutEffect(() => {
    if (request === null || !ready) {
      return
    }
    // Clearing keeps this one-shot while the transcript keeps changing.
    useAppStore.getState().clearPendingNativeChatSubagentReveal()
    const target = nativeChatSubagentRevealTarget(sections, request.agentId)
    if (target === null) {
      return
    }
    beginNavigation()
    openSubagentSections(target.openSections)
    requestJump({ id: target.messageId })
  }, [beginNavigation, openSubagentSections, ready, request, requestJump, sections])
}
