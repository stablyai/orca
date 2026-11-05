import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useHostStructuredAgent } from '@/runtime/use-host-structured-agent'
import { useStructuredAgentSessionHostCapabilityState } from '@/runtime/structured-agent-session-host-capability'
import { AGENT_SESSION_CREATE_FORK_RUNTIME_CAPABILITY } from '../../../../shared/agent-session/agent-session-create-capabilities'
import {
  agentSessionContextFloorSequence,
  latestAgentSessionContextClearSequence
} from '../../../../shared/agent-session/agent-session-context-clear'
import type { AgentJournalCursor } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionOptionsResult } from '../../../../shared/agent-session/options/agent-session-options-result'
import type { AgentType } from '../../../../shared/agent-status/contracts/agent-status-types'
import { isTuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent-config'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import {
  nativeChatForkableItemIds,
  nativeChatForkSupport,
  type NativeChatForkSupport
} from '../../../../shared/native-chat/native-chat-fork-offer'
import { launchNativeChatFork, nativeChatForkSurfaceAddress } from './native-chat-fork-launch'

/** What an offered row's button needs; the same object while support and pending hold. */
export type NativeChatForkRowAction = {
  support: Exclude<NativeChatForkSupport, { kind: 'none' }>
  /** A fork is opening; every fork action in the chat waits for it. */
  pending: boolean
  request: (throughItemId: string) => void
}

export type NativeChatForkSurface = NativeChatForkRowAction & {
  contextFloorSequence: number
  forkableItemIds: ReadonlySet<string>
  /** Handed to offered rows, so a change in which rows offer it re-renders only those rows. */
  rowAction: NativeChatForkRowAction
}

/** The chat's "Fork from this response"; undefined where its agent or host can't fork. */
export function useNativeChatFork(input: {
  sessionId: string
  tabId: string
  agent: AgentType
  target: RuntimeClientTarget
  worktreeId: string | null
  items: readonly AgentJournalRenderItem[]
  epoch: string | null
  contextFloor: AgentJournalCursor | undefined
  /** The chat's options read on its installed agent; the host's own discovery owns it. */
  sessionForkSupport: AgentSessionOptionsResult['forkSupport']
}): NativeChatForkSurface | undefined {
  const host = useStructuredAgentSessionHostCapabilityState(
    input.target,
    AGENT_SESSION_CREATE_FORK_RUNTIME_CAPABILITY
  )
  const registered = useHostStructuredAgent(input.target, input.agent)
  const support = nativeChatForkSupport(host, registered, input.sessionForkSupport)
  const latest = useRef(input)
  useLayoutEffect(() => {
    latest.current = input
  })
  // Reserved at the click, before any await, so a second click never starts a second fork.
  const inFlight = useRef(false)
  const [pending, setPending] = useState(false)
  const request = useCallback((throughItemId: string) => {
    const { agent, sessionId, tabId, target, worktreeId } = latest.current
    if (inFlight.current || !worktreeId || !isTuiAgent(agent)) {
      return
    }
    inFlight.current = true
    setPending(true)
    void launchNativeChatFork({
      agent,
      worktreeId,
      target,
      forkFrom: { sessionId, throughItemId },
      surfaceAddress: nativeChatForkSurfaceAddress(worktreeId, tabId)
    }).finally(() => {
      inFlight.current = false
      setPending(false)
    })
  }, [])
  const contextFloorSequence = Math.max(
    latestAgentSessionContextClearSequence(input.items),
    agentSessionContextFloorSequence(input.contextFloor, input.epoch)
  )
  // Streaming replaces the items array on every commit; keep the set while its members hold, so the
  // context and every offered row's `fork` stay the same objects.
  const forkableRef = useRef<ReadonlySet<string>>(new Set())
  const forkableItemIds = useMemo(() => {
    const next = nativeChatForkableItemIds(input.items)
    const previous = forkableRef.current
    return next.size === previous.size && [...next].every((id) => previous.has(id))
      ? previous
      : next
  }, [input.items])
  useLayoutEffect(() => {
    forkableRef.current = forkableItemIds
  }, [forkableItemIds])
  const supportKind = support.kind
  const fork = support.kind === 'known' ? support.fork : undefined
  const rowAction = useMemo<NativeChatForkRowAction>(
    () => ({
      support: fork ? { kind: 'known', fork } : { kind: 'unknown' },
      pending,
      request
    }),
    [fork, pending, request]
  )
  return useMemo(
    () =>
      supportKind === 'none' || !input.worktreeId || !isTuiAgent(input.agent)
        ? undefined
        : { ...rowAction, contextFloorSequence, forkableItemIds, rowAction },
    [contextFloorSequence, forkableItemIds, input.agent, input.worktreeId, rowAction, supportKind]
  )
}
