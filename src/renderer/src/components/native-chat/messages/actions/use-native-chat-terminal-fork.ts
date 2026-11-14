import {
  terminalForkPointBefore,
  terminalForkTurnEnd
} from '../../../../../../shared/native-chat/terminal-fork-point'
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { isTuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent-config'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import type { StructuredAgentSessionHostCapabilityState } from '../../../../../../shared/agent-session/structured-agent-session-host-capability'
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

// Module scope: the React Compiler bails out on try/finally inside a hook.
async function runWhilePending<T>(
  inFlight: { current: boolean },
  setPendingItemId: (id: string | null) => void,
  itemId: string,
  launch: () => Promise<T>
): Promise<T> {
  inFlight.current = true
  setPendingItemId(itemId)
  try {
    return await launch()
  } finally {
    inFlight.current = false
    setPendingItemId(null)
  }
}

/** Fork for a terminal chat. A Claude chat's host cuts a copy at a reply and Claude resumes it
 *  (`request`, when the host can cut); every terminal chat can fork as a recap through the Fork
 *  window. Absent without a workspace; a Claude chat's Fork is drawn disabled while its cut is unknown. */
export function useNativeChatTerminalFork(input: {
  agent: string
  worktreeId: string | null
  source: NativeChatTerminalForkSource | null
  messages: readonly NativeChatMessage[]
  cutHost: StructuredAgentSessionHostCapabilityState
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
      const { source, cutHost } = latest.current
      if (inFlight.current || !source || cutHost !== 'supported') {
        return undefined
      }
      return runWhilePending(inFlight, setPendingItemId, throughItemId, () =>
        launchNativeChatTerminalFork({
          source,
          // The reply's whole turn, tool work after its last text included.
          throughItemId:
            terminalForkTurnEnd(latest.current.messages, throughItemId) ?? throughItemId,
          ...(destination ? { destinationWorktreeId: destination.worktreeId } : {}),
          ...(draft ? { draft } : {})
        })
      )
    },
    []
  )
  const forkPointBefore = useCallback(
    (messageItemId: string): string | undefined =>
      terminalForkPointBefore(latest.current.messages, messageItemId),
    []
  )
  const latestForkItemId = useCallback(
    () => latest.current.messages.findLast(terminalForkPoint)?.id,
    []
  )
  const { openWorktreeFork, openWorktreeForkLatest, worktreeForkDialog } =
    useNativeChatWorktreeForkDialog(inFlight, latestForkItemId)
  const worktreeOffered = useNativeChatWorktreeForkOffered(input.worktreeId ?? '')
  // Only a Claude chat with a transcript waits to learn whether its host cuts; a recap needs no cut.
  const cutKnown = input.agent !== 'claude' || input.source === null || input.cutHost !== 'unknown'
  const rowAction = useMemo<NativeChatForkSurface['rowAction']>(
    () => ({
      support: cutKnown ? { kind: 'known', fork: 'checkpoint' } : { kind: 'unknown' },
      pendingItemId,
      request,
      forkPointBefore,
      // A terminal fork resumes the CLI, which cannot be handed a task to start in the background.
      subagentOffered: false,
      openWorktreeFork,
      worktreeForkOffered: worktreeOffered
    }),
    [cutKnown, forkPointBefore, openWorktreeFork, pendingItemId, request, worktreeOffered]
  )
  const enabled = isTuiAgent(input.agent) && input.worktreeId !== null
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
              !slot.activeTurnIsWorking &&
              slot.endsResponse !== false,
            forkLatest: () => 'none' as const,
            openWorktreeForkLatest,
            worktreeForkDialog
          }
        : undefined,
    [enabled, openWorktreeForkLatest, rowAction, worktreeForkDialog]
  )
}
