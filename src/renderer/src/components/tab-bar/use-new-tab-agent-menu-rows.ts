import { useEffect, useSyncExternalStore } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  STRUCTURED_AGENT_SESSION_AVAILABILITY_RUNTIME_CAPABILITY as AVAILABILITY,
  STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY as CATALOG
} from '../../../../shared/protocol-version'
import { LOCAL_EXECUTION_HOST_ID, parseExecutionHostId } from '../../../../shared/execution-host'
import { lastVerifiedRuntimeStatus } from '../../../../shared/runtime-host-status'
import { runtimeHostContactForEntry } from '../../../../shared/runtime-host-contact'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import { isNativeChatEnabled } from '../../../../shared/structured-native-chat-launch-route'
import { useAppStore } from '@/store'
import {
  structuredAgentLaunchSupport,
  type AgentLaunchRoutingInput
} from '@/lib/agent-launch-routing'
import {
  buildAgentLaunchRouteInput,
  workspaceKindForWorktreeId
} from '@/lib/agent-launch-route-input'
import { useHostStructuredAgentsVersion } from '@/lib/chat-provider-agents'
import { structuredAgentSessionTargetForHost } from '@/runtime/structured-agent-session-owner'
import {
  readHostStructuredAgents,
  readHostStructuredAgentsForRuntime,
  hostStructuredAgentsReadFailed,
  loadHostStructuredAgents
} from '@/runtime/host-structured-agents'
import { getRuntimeEnvironmentRevision } from '@/runtime/runtime-environment-revision'
import { useHostStructuredAgentAvailability } from '@/runtime/use-host-structured-agent-availability'
import {
  buildNewTabAgentMenuRows,
  type HostChatAnswer,
  type NewTabAgentMenuRow
} from '@/lib/new-tab-agent-menu-rows'
import {
  readLocalRuntimeCapabilityObservation,
  subscribeLocalRuntimeCapabilityObservation,
  ensureLocalRuntimeCapabilities
} from '@/runtime/local-runtime-capabilities'
import {
  useDetectedAgents,
  type AgentDetectionTarget,
  type UseDetectedAgentsResult
} from '@/hooks/useDetectedAgents'
import { readDetectedAgentsForTarget } from '@/lib/agent-detection-target-inventory'

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

export type NewTabAgentMenuModel =
  | { state: 'loading'; placeholderCount: number }
  | { state: 'settled'; rows: NewTabAgentMenuRow[]; detection: UseDetectedAgentsResult }

function catalogUnlearned(
  host: string,
  runtimeId: string | null | undefined,
  capabilities: readonly string[] | null | undefined
): boolean {
  return (
    runtimeId !== undefined &&
    capabilities?.includes(CATALOG) === true &&
    !readHostStructuredAgentsForRuntime(host, runtimeId) &&
    !hostStructuredAgentsReadFailed(host, runtimeId)
  )
}

/** `detectionTarget` is the workspace's agent-inventory host, resolved by the caller. */
export function useNewTabAgentMenuRows(
  worktreeId: string,
  open: boolean,
  detectionTarget: AgentDetectionTarget | undefined
): NewTabAgentMenuModel {
  // Why: hidden worktrees stay mounted, so only the shown one holds its host's streams.
  const worktreeShown = useAppStore((state) => state.activeWorktreeId === worktreeId)
  // Why: acquiring while the workspace is shown means the first open already knows its agents.
  const acquired = useDetectedAgents(open || worktreeShown ? detectionTarget : undefined)
  // Closing the menu or leaving the workspace must not erase the known inventory.
  const storedIds = useAppStore((state) =>
    detectionTarget ? readDetectedAgentsForTarget(state, detectionTarget) : null
  )
  const detection = { ...acquired, detectedIds: acquired.detectedIds ?? storedIds }
  useHostStructuredAgentsVersion()
  const localCapabilities = useSyncExternalStore(
    subscribeLocalRuntimeCapabilityObservation,
    readLocalRuntimeCapabilityObservation,
    readLocalRuntimeCapabilityObservation
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
      const contact = runtimeHostContactForEntry(status)
      return {
        executionHostId: input.executionHostId,
        runtimeId: host?.kind === 'runtime' ? lastVerifiedRuntimeStatus(status)?.runtimeId : null,
        pairingRevision:
          host?.kind === 'runtime' ? getRuntimeEnvironmentRevision(host.environmentId) : undefined,
        contact: `${status?.connectionGeneration}:${status?.hostContactEpoch}`,
        checking:
          contact.verdict === 'unverifiable' &&
          ['checking', 'transport-connecting'].includes(contact.reason),
        capabilities: input.hostCapabilities?.join(',')
      }
    })
  )
  const state = useAppStore.getState()
  const input = buildAgentLaunchRouteInput(state, { agent: 'claude', workspace })
  const chatEnabled = isNativeChatEnabled(settings)
  const plain = !chatEnabled || hostChatAnswer(input) === 'no-chats'
  const local = facts.executionHostId === LOCAL_EXECUTION_HOST_ID
  // Why a branch: a host publishing availability answers every agent from its one health snapshot;
  // an older host shows this client's facts, and the click's admission states the host's refusal.
  const published =
    input.hostCapabilities?.includes(AVAILABILITY) === true &&
    Boolean(structuredAgentSessionTargetForHost(facts.executionHostId))
  const availability = useHostStructuredAgentAvailability(
    published && !plain
      ? {
          executionHostId: facts.executionHostId,
          runtimeId: facts.runtimeId,
          pairingRevision: facts.pairingRevision,
          contact: facts.contact,
          hold: worktreeShown || open
        }
      : null
  )
  const roster = availability?.state === 'received' ? [...availability.byAgent.keys()] : undefined
  const localCatalog =
    local && roster
      ? roster
      : readHostStructuredAgents(LOCAL_EXECUTION_HOST_ID, state.runtimeStatusByEnvironmentId)?.map(
          ({ agent }) => agent
        )
  const hostCatalog =
    roster ??
    readHostStructuredAgents(facts.executionHostId, state.runtimeStatusByEnvironmentId)?.map(
      ({ agent }) => agent
    )
  const chatAgents = [
    ...new Set([
      'claude',
      'codex',
      ...(localCatalog ?? []),
      ...(hostCatalog ?? []),
      ...Object.keys(settings?.nativeChatProviders ?? {})
        .filter(isTuiAgent)
        .filter((agent) => settings?.nativeChatProviders?.[agent] === true)
    ])
  ].filter(isTuiAgent)
  const inventoryFailed =
    detection.detectedIds === null && (detection.detectionFailed || detection.needsServerUpdate)
  const localAcquiring =
    localCapabilities.state === 'unlearned' || localCapabilities.state === 'pending'
  const capabilityPending =
    input.hostCapabilities == null && (local ? localAcquiring : facts.checking)
  const hostCatalogPending =
    !roster &&
    availability?.state !== 'pending' &&
    catalogUnlearned(facts.executionHostId, facts.runtimeId, input.hostCapabilities)
  const localCatalogPending =
    !local &&
    catalogUnlearned(
      LOCAL_EXECUTION_HOST_ID,
      null,
      localCapabilities.state === 'known' ? localCapabilities.capabilities : null
    )
  useEffect(() => {
    if ((!open && !worktreeShown) || plain || inventoryFailed) {
      return
    }
    if (localCapabilities.state === 'unlearned') {
      void ensureLocalRuntimeCapabilities()
    }
    if (hostCatalogPending && facts.runtimeId !== undefined) {
      void loadHostStructuredAgents(facts.executionHostId, input.hostCapabilities, facts.runtimeId)
    }
    if (localCatalogPending && localCapabilities.state === 'known') {
      void loadHostStructuredAgents(LOCAL_EXECUTION_HOST_ID, localCapabilities.capabilities, null)
    }
  }, [
    open,
    worktreeShown,
    plain,
    inventoryFailed,
    localCapabilities,
    hostCatalogPending,
    localCatalogPending,
    facts,
    input.hostCapabilities
  ])
  // Only dependencies that can enable an action hold the cold fill; a failed inventory is terminal.
  if (
    !inventoryFailed &&
    ((detection.detectedIds === null && detectionTarget !== undefined) ||
      (!plain &&
        (capabilityPending ||
          (!local && localAcquiring) ||
          availability?.state === 'pending' ||
          hostCatalogPending ||
          localCatalogPending)))
  ) {
    return {
      state: 'loading',
      placeholderCount: Math.max(chatAgents.length, detection.detectedIds?.length ?? 0, 2)
    }
  }
  const rows = buildNewTabAgentMenuRows({
    settings,
    detectedOnHost: detection.detectedIds,
    chatAgents,
    hostChatAnswer: (agent) => {
      const route = buildAgentLaunchRouteInput(state, { agent, workspace })
      const preliminary = hostChatAnswer(
        roster ? { ...route, hostStructuredAgents: roster } : route
      )
      if (!roster || !['yes', 'not-yet-known', 'not-on-host'].includes(preliminary)) {
        return preliminary
      }
      const verdict =
        availability?.state === 'received' ? availability.byAgent.get(agent)?.state : undefined
      // An agent the host could not check keeps this client's facts; the click's admission decides.
      return !verdict || verdict === 'refused' ? 'not-on-host' : preliminary
    }
  }).map((row) => ({ ...row, executionHostId: parseExecutionHostId(facts.executionHostId)?.id }))
  return { state: 'settled', rows, detection }
}
