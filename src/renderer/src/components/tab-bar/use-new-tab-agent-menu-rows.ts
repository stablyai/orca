import { waitForPromiseWithSignal } from '../../../../shared/abort-signal-reason'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  STRUCTURED_AGENT_SESSION_AVAILABILITY_RUNTIME_CAPABILITY as AVAILABILITY,
  STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY as CATALOG
} from '../../../../shared/protocol-version'
import { LOCAL_EXECUTION_HOST_ID, parseExecutionHostId } from '../../../../shared/execution-host'
import { lastVerifiedRuntimeStatus } from '../../../../shared/runtime-host-status'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { isNativeChatEnabled } from '../../../../shared/structured-native-chat-launch-route'
import { isNativeChatProviderDisplayedOn } from '../../../../shared/native-chat-providers'
import { useAppStore } from '@/store'
import {
  structuredAgentLaunchSupport,
  type AgentLaunchRoutingInput
} from '@/lib/agent-launch-routing'
import {
  buildAgentLaunchRouteInput,
  workspaceKindForWorktreeId
} from '@/lib/agent-launch-route-input'
import { chatProviderAgents, useHostStructuredAgentsVersion } from '@/lib/chat-provider-agents'
import { askHostCreateSupport } from '@/lib/structured-agent-session-host-admission'
import { structuredAgentSessionTargetForHost } from '@/runtime/structured-agent-session-owner'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import {
  readHostStructuredAgents,
  relearnHostStructuredAgents
} from '@/runtime/host-structured-agents'
import { getRuntimeEnvironmentRevision } from '@/runtime/runtime-environment-revision'
import { useHostStructuredAgentAvailability } from '@/runtime/use-host-structured-agent-availability'
import { buildNewTabAgentMenuRows, type HostChatAnswer } from '@/lib/new-tab-agent-menu-rows'
import {
  readLocalRuntimeCapabilitiesOrUnknown,
  subscribeLocalRuntimeCapabilitiesKnown
} from '@/runtime/local-runtime-capabilities'
import { useDetectedAgents, type AgentDetectionTarget } from '@/hooks/useDetectedAgents'
import { readDetectedAgentsForTarget } from '@/lib/agent-detection-target-inventory'
import {
  hostChatAnswersVersion,
  readHostChatAnswer,
  recordHostChatAnswer,
  subscribeHostChatAnswers
} from './new-tab-host-chat-answers'

function hostChatAnswer(input: AgentLaunchRoutingInput): HostChatAnswer {
  const support = structuredAgentLaunchSupport(input)
  if (support.supported) {
    return 'yes'
  }
  switch (support.blocker) {
    case 'runtime-capability-unknown':
      return 'not-yet-known'
    case 'agent-without-structured-session':
      return !input.hostStructuredAgents && input.hostCapabilities?.includes(CATALOG) !== false
        ? 'not-yet-known'
        : 'not-on-host'
    case 'remote-execution-host':
      return 'ssh'
    case 'project-runtime':
      return 'wsl'
    case 'runtime-capability':
    case 'client-capability':
      return 'no-chats'
    case 'custom-start-directory':
    case 'reused-terminal':
      return 'yes'
  }
}

function answerFromSupport(
  support: Awaited<ReturnType<typeof askHostCreateSupport>>
): HostChatAnswer {
  if (support.kind === 'admitted') {
    return 'yes'
  }
  if (support.kind === 'declined') {
    if (['remote', 'remote-execution-host', 'ssh'].includes(support.reason ?? '')) {
      return 'ssh'
    }
    if (['wsl', 'project-runtime'].includes(support.reason ?? '')) {
      return 'wsl'
    }
  }
  return 'not-on-host'
}

export type NewTabAgentMenuModel = ReturnType<typeof useNewTabAgentMenuRows>

/** `detectionTarget` is the workspace's agent-inventory host, resolved by the caller. */
export function useNewTabAgentMenuRows(
  worktreeId: string,
  open: boolean,
  detectionTarget: AgentDetectionTarget | undefined
) {
  const acquired = useDetectedAgents(open ? detectionTarget : undefined)
  // Why: only acquisition waits for the open menu; closing it must not erase the known inventory.
  const storedIds = useAppStore((state) =>
    detectionTarget ? readDetectedAgentsForTarget(state, detectionTarget) : null
  )
  const detection = { ...acquired, detectedIds: acquired.detectedIds ?? storedIds }
  useHostStructuredAgentsVersion()
  useSyncExternalStore(
    subscribeLocalRuntimeCapabilitiesKnown,
    readLocalRuntimeCapabilitiesOrUnknown,
    readLocalRuntimeCapabilitiesOrUnknown
  )
  const settings = useAppStore((state) => state.settings)
  const workspace = { kind: workspaceKindForWorktreeId(worktreeId), worktreeId }
  const facts = useAppStore(
    useShallow((state) => {
      const input = buildAgentLaunchRouteInput(state, { agent: 'claude', workspace })
      const host = parseExecutionHostId(input.executionHostId)
      const status =
        host?.kind === 'runtime'
          ? state.runtimeStatusByEnvironmentId.get(host.environmentId)
          : undefined
      return {
        executionHostId: input.executionHostId,
        runtimeId: lastVerifiedRuntimeStatus(status)?.runtimeId,
        pairingRevision:
          host?.kind === 'runtime' ? getRuntimeEnvironmentRevision(host.environmentId) : undefined,
        connection: status?.connectionGeneration,
        reconnect: status?.hostContactEpoch,
        preliminary: hostChatAnswer(input),
        capabilities: input.hostCapabilities?.join(','),
        command: input.executionHostId === 'local' ? state.settings?.agentCmdOverrides : undefined,
        args: input.executionHostId === 'local' ? state.settings?.agentDefaultArgs : undefined,
        env: input.executionHostId === 'local' ? state.settings?.agentDefaultEnv : undefined,
        inheritShell:
          input.executionHostId === 'local'
            ? state.settings?.nativeChatInheritShellEnvironment
            : undefined,
        shellVariables:
          input.executionHostId === 'local'
            ? state.settings?.nativeChatShellEnvironmentVariables
            : undefined
      }
    })
  )
  const state = useAppStore.getState()
  const inputFor = (agent: TuiAgent) => buildAgentLaunchRouteInput(state, { agent, workspace })
  const input = inputFor('claude')
  const catalogLoaded =
    Boolean(readHostStructuredAgents(input.executionHostId, state.runtimeStatusByEnvironmentId)) ||
    input.hostCapabilities?.includes(CATALOG) === false
  const chatAgents = [
    ...new Set([
      ...chatProviderAgents(LOCAL_EXECUTION_HOST_ID, state.runtimeStatusByEnvironmentId),
      ...chatProviderAgents(input.executionHostId, state.runtimeStatusByEnvironmentId),
      ...Object.keys(settings?.nativeChatProviders ?? {})
        .filter(isTuiAgent)
        .filter((agent) => settings?.nativeChatProviders?.[agent] === true)
    ])
  ]
  const enabled = (agent: TuiAgent) =>
    !settings?.disabledTuiAgents?.includes(agent) &&
    isNativeChatProviderDisplayedOn(settings, agent, detection.detectedIds)
  const eligible =
    isNativeChatEnabled(settings) && input.hostCapabilities !== null
      ? chatAgents
          .filter(
            (agent) =>
              enabled(agent) &&
              detection.detectedIds?.includes(agent) !== false &&
              ['yes', 'not-yet-known'].includes(hostChatAnswer(inputFor(agent)))
          )
          .join(',')
      : ''
  // Only launch-affecting configuration retires display reads; unrelated settings do not.
  // Why not `open`: answers outlive the menu so a reopen shows them at once while they refresh.
  const owner = useMemo(() => ({ ...facts, worktreeId, eligible }), [facts, worktreeId, eligible])
  const ownerKey = useMemo(() => JSON.stringify({ ...facts, worktreeId }), [facts, worktreeId])
  useSyncExternalStore(subscribeHostChatAnswers, hostChatAnswersVersion, hostChatAnswersVersion)
  // Agents this open's reads gave up on; cleared with the reads so the next open asks again.
  const [unanswered, setUnanswered] = useState<ReadonlySet<TuiAgent>>(new Set())
  const chatEnabled = isNativeChatEnabled(settings)
  // Why a branch: a host publishing availability answers every agent at once from its own stream;
  // an older host keeps the per-agent createSupport reads below, unchanged.
  const publishing = input.hostCapabilities?.includes(AVAILABILITY) === true
  const published =
    Boolean(structuredAgentSessionTargetForHost(facts.executionHostId)) && publishing
  // Why: hidden worktrees stay mounted, so only the shown one holds its host's checks.
  const worktreeShown = useAppStore((state) => state.activeWorktreeId === worktreeId)
  const availability = useHostStructuredAgentAvailability(
    published && chatEnabled && (worktreeShown || open)
      ? {
          executionHostId: facts.executionHostId,
          runtimeId:
            parseExecutionHostId(facts.executionHostId)?.kind === 'runtime'
              ? facts.runtimeId
              : null,
          worktreeId,
          contact: `${facts.pairingRevision}:${facts.connection}:${facts.reconnect}`
        }
      : null
  )
  useEffect(() => {
    if (!open || !chatEnabled) {
      return
    }
    const state = useAppStore.getState()
    if (!catalogLoaded) {
      const input = buildAgentLaunchRouteInput(state, {
        agent: 'claude',
        workspace: { kind: workspaceKindForWorktreeId(worktreeId), worktreeId }
      })
      void relearnHostStructuredAgents(
        input.executionHostId,
        input.hostCapabilities,
        state.runtimeStatusByEnvironmentId
      )
    }
  }, [open, chatEnabled, facts, worktreeId, catalogLoaded])
  useEffect(() => {
    const target = structuredAgentSessionTargetForHost(owner.executionHostId)
    if (!open || !target || !owner.eligible || published) {
      return
    }
    let active = true
    let answered = 0
    const controller = new AbortController()
    const agents = owner.eligible.split(',').filter(isTuiAgent)
    // Why: a slow host is not a refusal; the deadline only releases the reads.
    const giveUp = (gaveUp: readonly TuiAgent[]) =>
      setUnanswered((previous) => new Set([...previous, ...gaveUp]))
    const timer = setTimeout(() => {
      active = false
      controller.abort()
      giveUp(agents)
    }, 10_000)
    for (const agent of agents) {
      void waitForPromiseWithSignal(
        askHostCreateSupport(target, toRuntimeWorktreeSelector(worktreeId), agent, {
          signal: controller.signal,
          expectedEnvironmentPairingRevision: owner.pairingRevision,
          expectedEnvironmentRuntimeId: owner.runtimeId
        }),
        controller.signal
      ).then(
        (support) => {
          if (!active) {
            return
          }
          answered += 1
          if (answered === agents.length) {
            clearTimeout(timer)
          }
          if (support.kind === 'admitted' || support.kind === 'declined') {
            recordHostChatAnswer(ownerKey, agent, answerFromSupport(support))
          } else {
            giveUp([agent])
          }
        },
        () => undefined
      )
    }
    return () => {
      active = false
      clearTimeout(timer)
      controller.abort()
      setUnanswered(new Set())
    }
  }, [owner, ownerKey, open, worktreeId, published])
  const asking = structuredAgentSessionTargetForHost(owner.executionHostId)
    ? owner.eligible.split(',')
    : []
  const rows = buildNewTabAgentMenuRows({
    settings,
    detectedOnHost: detection.detectedIds,
    chatAgents,
    catalogLoaded,
    hostChatAnswer: (agent) => {
      const preliminary = hostChatAnswer(inputFor(agent))
      if (!['yes', 'not-yet-known'].includes(preliminary)) {
        return preliminary
      }
      if (availability) {
        // One complete generation answers every row at once; until it lands, rows wait disabled.
        if (!availability.ready) {
          return 'not-yet-known'
        }
        const answer = availability.byAgent.get(agent)
        // An agent the host could not check leaves this client's facts, as an unanswered read does.
        return answer && answer.state !== 'unknown'
          ? answerFromSupport(
              answer.state === 'available'
                ? { kind: 'admitted' }
                : { kind: 'declined', ...(answer.reason ? { reason: answer.reason } : {}) }
            )
          : preliminary
      }
      const recorded = readHostChatAnswer(ownerKey, agent)
      if (recorded) {
        return recorded
      }
      // Why: a row stays quietly disabled while its host is asked, so it never flips under the pointer.
      // A host that could not answer leaves this client's facts; the click's admission owns a refusal.
      return open && asking.includes(agent) && !unanswered.has(agent)
        ? 'not-yet-known'
        : preliminary
    }
  }).map((row) => ({ ...row, executionHostId: parseExecutionHostId(facts.executionHostId)?.id }))
  return { rows, detection, availability }
}
