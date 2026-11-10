import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import { isRootAgentJournalItem } from '../../../../../../shared/agent-session/journal/agent-session-journal-producer'
import type { NativeChatMessageSlot } from '../../conversation/slots/native-chat-transcript-slots'
import type {
  NativeChatForkDestination,
  NativeChatForkSurface,
  NativeChatPaneFork
} from './use-native-chat-fork'
import type { NativeChatSideChatRequest } from './native-chat-fork-launch'
import { useNativeChatWorktreeForkDialog } from './use-native-chat-worktree-fork-dialog'
import { useNativeChatWorktreeForkOffered } from './native-chat-worktree-fork'
import {
  launchNativeChatTerminalFork,
  type NativeChatTerminalForkSource
} from './native-chat-terminal-fork-launch'

const NO_ITEMS: ReadonlySet<string> = new Set()

/** A finished reply of the main agent in a terminal chat, the point a fork copies through. */
function terminalForkPoint(message: NativeChatMessage): boolean {
  return (
    message.role === 'assistant' &&
    message.source === 'transcript' &&
    !message.agentStart &&
    isRootAgentJournalItem(message)
  )
}

/** Fork for a terminal Claude chat: the host cuts a copy of its conversation at a reply and Claude
 *  resumes it in a new tab or a new worktree. Absent for other agents or without a transcript. */
export function useNativeChatTerminalFork(input: {
  agent: string
  source: NativeChatTerminalForkSource | null
  messages: readonly NativeChatMessage[]
}): NativeChatPaneFork | undefined {
  const latest = useRef(input)
  useLayoutEffect(() => {
    latest.current = input
  })
  const inFlight = useRef(false)
  const [pendingItemId, setPendingItemId] = useState<string | null>(null)
  const request = useCallback(
    async (
      throughItemId: string,
      _side?: NativeChatSideChatRequest,
      destination?: NativeChatForkDestination,
      draft?: string
    ) => {
      const { source } = latest.current
      if (inFlight.current || !source) {
        return undefined
      }
      inFlight.current = true
      setPendingItemId(throughItemId)
      try {
        return await launchNativeChatTerminalFork({
          source,
          throughItemId,
          ...(destination ? { destinationWorktreeId: destination.worktreeId } : {}),
          ...(draft ? { draft } : {})
        })
      } finally {
        inFlight.current = false
        setPendingItemId(null)
      }
    },
    []
  )
  const forkPointBefore = useCallback((messageItemId: string): string | undefined => {
    const { messages } = latest.current
    const index = messages.findIndex((message) => message.id === messageItemId)
    return index === -1 ? undefined : messages.slice(0, index).findLast(terminalForkPoint)?.id
  }, [])
  const latestForkItemId = useCallback(
    () => latest.current.messages.findLast(terminalForkPoint)?.id,
    []
  )
  const { openWorktreeFork, openWorktreeForkLatest, worktreeForkDialog } =
    useNativeChatWorktreeForkDialog(inFlight, latestForkItemId)
  const worktreeOffered = useNativeChatWorktreeForkOffered(input.source?.worktreeId ?? '')
  const rowAction = useMemo<NativeChatForkSurface['rowAction']>(
    () => ({
      support: { kind: 'known', fork: 'checkpoint' },
      pendingItemId,
      request,
      forkPointBefore,
      // A terminal fork resumes the CLI, which cannot be handed a task to start in the background.
      subagentOffered: false,
      ...(worktreeOffered ? { openWorktreeFork } : {})
    }),
    [forkPointBefore, openWorktreeFork, pendingItemId, request, worktreeOffered]
  )
  const enabled = input.agent === 'claude' && input.source !== null
  return useMemo(
    () =>
      enabled
        ? {
            ...rowAction,
            rowAction,
            contextFloorSequence: 0,
            forkableItemIds: NO_ITEMS,
            offersRow: (slot: NativeChatMessageSlot) =>
              terminalForkPoint(slot.message) &&
              slot.depth === 0 &&
              !slot.activeTurnIsWorking &&
              slot.endsResponse !== false,
            forkLatest: () => 'none' as const,
            ...(worktreeOffered ? { openWorktreeForkLatest } : {}),
            worktreeForkDialog
          }
        : undefined,
    [enabled, openWorktreeForkLatest, rowAction, worktreeForkDialog, worktreeOffered]
  )
}
