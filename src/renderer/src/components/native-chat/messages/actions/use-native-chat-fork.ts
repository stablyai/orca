import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useHostStructuredAgent } from '@/runtime/native-chat/agent-catalogs/use-host-structured-agent'
import { useStructuredAgentSessionHostCapabilityState } from '@/runtime/native-chat/host-capabilities/structured-agent-session-host-capability'
import {
  AGENT_SESSION_CREATE_FORK_RUNTIME_CAPABILITY,
  AGENT_SESSION_CREATE_FORK_ORIGINAL_RUNTIME_CAPABILITY
} from '../../../../../../shared/agent-session/agent-session-create-capabilities'
import {
  agentSessionContextFloorSequence,
  latestAgentSessionContextClearSequence
} from '../../../../../../shared/agent-session/agent-session-context-clear'
import type { AgentJournalCursor } from '../../../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentSessionLatestTurn } from '../../../../../../shared/agent-session/agent-session-wire'
import type {
  AgentJournalSubmission,
  AgentJournalRenderItem
} from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionOptionsResult } from '../../../../../../shared/agent-session/options/protocol/agent-session-options-result'
import type { AgentType } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import { isTuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent-config'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import {
  nativeChatForkInventory,
  nativeChatForkRequiresInheritedOriginal,
  nativeChatForkSupport,
  nativeChatLatestForkItemId,
  type NativeChatForkSupport
} from '../../../../../../shared/native-chat/native-chat-fork-offer'
import {
  launchNativeChatFork,
  nativeChatForkSurfaceAddress,
  type NativeChatForkOutcome,
  type NativeChatSideChatRequest
} from '@/components/native-chat/messages/actions/native-chat-fork-launch'
import type { NativeChatStructuredViewProps } from '@/components/native-chat/native-chat-view-types'
import { beginNativeChatSideChatPlacement } from '@/components/native-chat/messages/actions/native-chat-side-chat-placement'
import {
  useNativeChatSideChat,
  type NativeChatSideChat
} from '@/components/native-chat/messages/actions/use-native-chat-side-chat'

/** What an offered row's button needs; the same object while support and pending hold. */
export type NativeChatForkRowAction = {
  support: Exclude<NativeChatForkSupport, { kind: 'none' }>
  /** The row whose fork is opening; every fork action in the chat waits for it. */
  pendingItemId: string | null
  /** Undefined when nothing started: a fork is already opening, or the chat has no workspace. */
  request: (
    throughItemId: string,
    side?: NativeChatSideChatRequest
  ) => Promise<NativeChatForkOutcome | undefined>
}

/** What `/fork` did: opened a fork, waited on one already opening, or found no response to copy. */
export type NativeChatForkLatestOutcome = 'started' | 'pending' | 'none'

export type NativeChatForkSurface = NativeChatForkRowAction & {
  contextFloorSequence: number
  forkableItemIds: ReadonlySet<string>
  inheritedThroughSequence?: number
  /** Handed to offered rows, so a change in which rows offer it re-renders only those rows. */
  rowAction: NativeChatForkRowAction
}

/** The rows' surface plus `/fork`: the same request, through the newest response still in context. */
export type NativeChatPaneFork = NativeChatForkSurface & {
  forkLatest: () => NativeChatForkLatestOutcome
}

/** The chat's "Fork from this response"; undefined where its agent or host can't fork. */
export function useNativeChatFork(input: {
  sessionId: string
  tabId: string
  agent: AgentType
  target: RuntimeClientTarget
  worktreeId: string | null
  items: readonly AgentJournalRenderItem[]
  submissions?: readonly AgentJournalSubmission[]
  latestTurn?: AgentSessionLatestTurn | null
  epoch: string | null
  contextFloor: AgentJournalCursor | undefined
  /** The chat's options read on its installed agent; the host's own discovery owns it. */
  sessionForkSupport: AgentSessionOptionsResult['forkSupport']
}): NativeChatPaneFork | undefined {
  const host = useStructuredAgentSessionHostCapabilityState(
    input.target,
    AGENT_SESSION_CREATE_FORK_RUNTIME_CAPABILITY
  )
  const inheritedOriginalHost = useStructuredAgentSessionHostCapabilityState(
    input.target,
    AGENT_SESSION_CREATE_FORK_ORIGINAL_RUNTIME_CAPABILITY,
    true
  )
  const registered = useHostStructuredAgent(input.target, input.agent)
  const support = nativeChatForkSupport(
    host,
    registered,
    input.sessionForkSupport,
    inheritedOriginalHost
  )
  const latest = useRef({ ...input, support })
  useLayoutEffect(() => {
    latest.current = { ...input, support }
  })
  // Reserved at the click, before any await, so a second click never starts a second fork.
  const inFlight = useRef(false)
  const [pendingItemId, setPendingItemId] = useState<string | null>(null)
  const request = useCallback(
    (
      throughItemId: string,
      side?: NativeChatSideChatRequest
    ): Promise<NativeChatForkOutcome | undefined> => {
      const { agent, sessionId, tabId, target, worktreeId } = latest.current
      if (inFlight.current || !worktreeId || !isTuiAgent(agent)) {
        return Promise.resolve(undefined)
      }
      inFlight.current = true
      setPendingItemId(throughItemId)
      const placement = side ? beginNativeChatSideChatPlacement(worktreeId, tabId) : undefined
      let outcome: NativeChatForkOutcome = {}
      return launchNativeChatFork({
        agent,
        worktreeId,
        target,
        forkFrom: { sessionId, throughItemId },
        forkRequiresInheritedOriginal:
          latest.current.support.kind === 'known'
            ? nativeChatForkRequiresInheritedOriginal(
                latest.current.items,
                latest.current.support.fork,
                throughItemId,
                {
                  submissions: latest.current.submissions ?? [],
                  latestTurn: latest.current.latestTurn
                }
              )
            : undefined,
        surfaceAddress: nativeChatForkSurfaceAddress(worktreeId, tabId),
        ...(side ? { side } : {})
      })
        .then((launched) => (outcome = launched))
        .finally(() => {
          // A question that never went out leaves its fork in the background.
          placement?.settle(outcome.question === 'failed' ? undefined : outcome.chat)
          inFlight.current = false
          setPendingItemId(null)
        })
    },
    []
  )
  const contextFloorSequence = Math.max(
    latestAgentSessionContextClearSequence(input.items),
    agentSessionContextFloorSequence(input.contextFloor, input.epoch)
  )
  // Streaming replaces the items array on every commit; keep the set while its members hold, so the
  // context and every offered row's `fork` stay the same objects.
  const forkableRef = useRef<ReadonlySet<string>>(new Set())
  const inventory = useMemo(() => nativeChatForkInventory(input.items), [input.items])
  const { inheritedThroughSequence } = inventory
  const forkableItemIds = useMemo(() => {
    const next = inventory.forkableItemIds
    const previous = forkableRef.current
    return next.size === previous.size && [...next].every((id) => previous.has(id))
      ? previous
      : next
  }, [inventory])
  useLayoutEffect(() => {
    forkableRef.current = forkableItemIds
  }, [forkableItemIds])
  const forkLatest = useCallback((): NativeChatForkLatestOutcome => {
    if (inFlight.current) {
      return 'pending'
    }
    const { items, contextFloor, epoch } = latest.current
    const throughItemId = nativeChatLatestForkItemId(items, {
      contextFloorSequence: Math.max(
        latestAgentSessionContextClearSequence(items),
        agentSessionContextFloorSequence(contextFloor, epoch)
      ),
      forkableItemIds: nativeChatForkInventory(items).forkableItemIds
    })
    if (!throughItemId) {
      return 'none'
    }
    request(throughItemId)
    return 'started'
  }, [request])
  const supportKind = support.kind
  const fork = support.kind === 'known' ? support.fork : undefined
  const inheritedOriginal = support.kind === 'known' && support.inheritedOriginal === true
  const rowAction = useMemo<NativeChatForkRowAction>(
    () => ({
      support: fork ? { kind: 'known', fork, inheritedOriginal } : { kind: 'unknown' },
      pendingItemId,
      request
    }),
    [fork, inheritedOriginal, pendingItemId, request]
  )
  return useMemo(
    () =>
      supportKind === 'none' || !input.worktreeId || !isTuiAgent(input.agent)
        ? undefined
        : {
            ...rowAction,
            contextFloorSequence,
            forkableItemIds,
            inheritedThroughSequence,
            rowAction,
            forkLatest
          },
    [
      contextFloorSequence,
      forkableItemIds,
      forkLatest,
      inheritedThroughSequence,
      input.agent,
      input.worktreeId,
      rowAction,
      supportKind
    ]
  )
}

/** The pane's fork and the `/btw` side chat built on it. */
export type NativeChatPaneForks = {
  fork: NativeChatPaneFork | undefined
  sideChat: NativeChatSideChat | undefined
}

/** A structured pane's fork, shared by its response rows, `/fork` and `/btw`. */
export function useNativeChatPaneFork(
  pane: Pick<NativeChatStructuredViewProps, 'sessionId' | 'tabId' | 'agent' | 'target'>,
  chat: {
    journalItems: readonly AgentJournalRenderItem[]
    submissions?: readonly AgentJournalSubmission[]
    latestTurn?: AgentSessionLatestTurn | null
    epoch: string | null
    contextFloor: AgentJournalCursor | undefined
    forkSupport: AgentSessionOptionsResult['forkSupport']
  },
  worktreeId: string | null
): NativeChatPaneForks {
  const fork = useNativeChatFork({
    sessionId: pane.sessionId,
    tabId: pane.tabId,
    agent: pane.agent,
    target: pane.target,
    worktreeId,
    items: chat.journalItems,
    submissions: chat.submissions,
    latestTurn: chat.latestTurn,
    epoch: chat.epoch,
    contextFloor: chat.contextFloor,
    sessionForkSupport: chat.forkSupport
  })
  const sideChat = useNativeChatSideChat(fork)
  return useMemo(() => ({ fork, sideChat }), [fork, sideChat])
}
