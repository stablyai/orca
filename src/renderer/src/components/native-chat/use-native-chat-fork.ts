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
import type { AgentType } from '../../../../shared/agent-status/contracts/agent-status-types'
import { isTuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent-config'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import {
  nativeChatForkSupport,
  type NativeChatForkSupport
} from '../../../../shared/native-chat/native-chat-fork-offer'
import { launchNativeChatFork, nativeChatForkSurfaceAddress } from './native-chat-fork-launch'

export type NativeChatForkSurface = {
  support: Exclude<NativeChatForkSupport, { kind: 'none' }>
  contextFloorSequence: number
  /** A fork is opening; every fork action in the chat waits for it. */
  pending: boolean
  request: (throughItemId: string) => void
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
}): NativeChatForkSurface | undefined {
  const host = useStructuredAgentSessionHostCapabilityState(
    input.target,
    AGENT_SESSION_CREATE_FORK_RUNTIME_CAPABILITY
  )
  const registered = useHostStructuredAgent(input.target, input.agent)
  const support = nativeChatForkSupport(host, registered)
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
  const supportKind = support.kind
  const fork = support.kind === 'known' ? support.fork : undefined
  return useMemo(
    () =>
      supportKind === 'none' || !input.worktreeId || !isTuiAgent(input.agent)
        ? undefined
        : {
            support: fork ? { kind: 'known' as const, fork } : { kind: 'unknown' as const },
            contextFloorSequence,
            pending,
            request
          },
    [contextFloorSequence, fork, input.agent, input.worktreeId, pending, request, supportKind]
  )
}
