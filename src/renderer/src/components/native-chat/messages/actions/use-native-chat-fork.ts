import type { NativeChatMessageSlot } from '../../conversation/slots/native-chat-transcript-slots'
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useHostStructuredAgent } from '@/runtime/native-chat/agent-catalogs/use-host-structured-agent'
import { useStructuredAgentSessionHostCapabilityState } from '@/runtime/native-chat/host-capabilities/structured-agent-session-host-capability'
import {
  AGENT_SESSION_CREATE_FORK_RUNTIME_CAPABILITY,
  AGENT_SESSION_CREATE_FORK_ORIGINAL_RUNTIME_CAPABILITY,
  AGENT_SESSION_CREATE_FORK_WORKTREE_RUNTIME_CAPABILITY
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
import type { AgentSessionOptionsResult } from '../../../../../../shared/agent-session/options/agent-session-options-result'
import type { AgentType } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import { isTuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent-config'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import {
  nativeChatForkInventory,
  nativeChatForkRequiresInheritedOriginal,
  nativeChatForkSupport,
  type NativeChatForkSupport
} from '../../../../../../shared/native-chat/native-chat-fork-offer'
import {
  launchNativeChatFork,
  nativeChatForkSurfaceAddress,
  type NativeChatForkOutcome,
  type NativeChatSideChatRequest
} from '@/components/native-chat/messages/actions/native-chat-fork-launch'
import type { NativeChatStructuredViewProps } from '@/components/native-chat/native-chat-view-types'
import type { NativeChatWorktreeForkMode } from './native-chat-worktree-fork'
import { nativeChatForkPoint } from './native-chat-fork-point'
import { useNativeChatWorktreeForkDialog } from './use-native-chat-worktree-fork-dialog'
import { captureStructuredLaunchSurfaceAddress } from '@/lib/agent-session/launch/structured-agent-session-launch-surface'
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
    side?: NativeChatSideChatRequest,
    destination?: NativeChatForkDestination,
    draft?: string
  ) => Promise<NativeChatForkOutcome | undefined>
  /** Asks where a fork into a new worktree should branch from; absent where the host can't. */
  openWorktreeFork?: (
    throughItemId: string,
    mode?: NativeChatWorktreeForkMode,
    draft?: string
  ) => void
  /** False where a fork cannot be handed a task to start in the background (terminal chats). */
  subagentOffered?: boolean
  /** The response a fork from one of your messages copies through: the last one before it. */
  forkPointBefore?: (messageItemId: string) => string | undefined
}

/** Another worktree the fork opens in, instead of beside its source. */
export type NativeChatForkDestination = { worktreeId: string }

/** The response a fork into a new worktree copies through, while its dialog is open. */
export type NativeChatWorktreeForkDialog = {
  throughItemId: string
  mode: NativeChatWorktreeForkMode
  /** Your message, left unsent in the fork's composer. */
  draft?: string
  close: () => void
}

/** What `/fork` did: opened a fork, waited on one already opening, or found no response to copy. */
export type NativeChatForkLatestOutcome = 'started' | 'pending' | 'none'

export type NativeChatForkSurface = NativeChatForkRowAction & {
  /** Overrides which rows offer Fork, for chats without a session journal (terminal chats). */
  offersRow?: (slot: NativeChatMessageSlot) => boolean
  contextFloorSequence: number
  forkableItemIds: ReadonlySet<string>
  inheritedThroughSequence?: number
  /** Handed to offered rows, so a change in which rows offer it re-renders only those rows. */
  rowAction: NativeChatForkRowAction
}

/** The rows' surface plus `/fork`: the same request, through the newest response still in context. */
export type NativeChatPaneFork = NativeChatForkSurface & {
  forkLatest: () => NativeChatForkLatestOutcome
  /** Opens the new-worktree fork from the newest response still in context; false when there is none. */
  openWorktreeForkLatest?: (mode?: NativeChatWorktreeForkMode) => boolean
  worktreeForkDialog: NativeChatWorktreeForkDialog | null
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
  const worktreeHost = useStructuredAgentSessionHostCapabilityState(
    input.target,
    AGENT_SESSION_CREATE_FORK_WORKTREE_RUNTIME_CAPABILITY
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
      side?: NativeChatSideChatRequest,
      destination?: NativeChatForkDestination,
      draft?: string
    ): Promise<NativeChatForkOutcome | undefined> => {
      const { agent, sessionId, tabId, target, worktreeId } = latest.current
      if (inFlight.current || !worktreeId || !isTuiAgent(agent)) {
        return Promise.resolve(undefined)
      }
      inFlight.current = true
      setPendingItemId(throughItemId)
      const placement =
        side && !destination ? beginNativeChatSideChatPlacement(worktreeId, tabId) : undefined
      let outcome: NativeChatForkOutcome = {}
      return launchNativeChatFork({
        agent,
        worktreeId: destination?.worktreeId ?? worktreeId,
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
        surfaceAddress: destination
          ? captureStructuredLaunchSurfaceAddress(destination.worktreeId)
          : nativeChatForkSurfaceAddress(worktreeId, tabId),
        ...(side ? { side } : {}),
        ...(draft ? { draft } : {})
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
  const latestForkItemId = useCallback(
    (): string | undefined => nativeChatForkPoint(latest.current),
    []
  )
  const forkPointBefore = useCallback(
    (messageItemId: string): string | undefined =>
      nativeChatForkPoint(latest.current, messageItemId),
    []
  )
  const forkLatest = useCallback((): NativeChatForkLatestOutcome => {
    if (inFlight.current) {
      return 'pending'
    }
    const throughItemId = latestForkItemId()
    if (!throughItemId) {
      return 'none'
    }
    request(throughItemId)
    return 'started'
  }, [latestForkItemId, request])
  const worktreeForkOffered = worktreeHost === 'supported'
  const { openWorktreeFork, openWorktreeForkLatest, worktreeForkDialog } =
    useNativeChatWorktreeForkDialog(inFlight, latestForkItemId)
  const supportKind = support.kind
  const fork = support.kind === 'known' ? support.fork : undefined
  const inheritedOriginal = support.kind === 'known' && support.inheritedOriginal === true
  const rowAction = useMemo<NativeChatForkRowAction>(
    () => ({
      support: fork ? { kind: 'known', fork, inheritedOriginal } : { kind: 'unknown' },
      pendingItemId,
      request,
      forkPointBefore,
      ...(worktreeForkOffered ? { openWorktreeFork } : {})
    }),
    [
      fork,
      forkPointBefore,
      inheritedOriginal,
      openWorktreeFork,
      pendingItemId,
      request,
      worktreeForkOffered
    ]
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
            forkLatest,
            ...(worktreeForkOffered ? { openWorktreeForkLatest } : {}),
            worktreeForkDialog
          },
    [
      contextFloorSequence,
      forkableItemIds,
      forkLatest,
      inheritedThroughSequence,
      input.agent,
      input.worktreeId,
      rowAction,
      supportKind,
      openWorktreeForkLatest,
      worktreeForkDialog,
      worktreeForkOffered
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
