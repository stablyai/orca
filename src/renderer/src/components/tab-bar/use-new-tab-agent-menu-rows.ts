import { useSyncExternalStore } from 'react'
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
  buildAgentLaunchRouteInput,
  workspaceKindForWorktreeId,
  type ProspectiveWorkspace
} from '@/lib/agent-launch-route-input'
import { useHostStructuredAgentsVersion } from '@/lib/chat-provider-agents'
import { structuredAgentSessionTargetForHost } from '@/runtime/structured-agent-session-owner'
import {
  readHostStructuredAgents,
  readHostStructuredAgentsForRuntime,
  hostStructuredAgentsReadFailed
} from '@/runtime/host-structured-agents'
import { getRuntimeEnvironmentRevision } from '@/runtime/runtime-environment-revision'
import { useHostStructuredAgentAvailability } from '@/runtime/use-host-structured-agent-availability'
import {
  buildNewTabAgentMenuRows,
  hostChatAnswer,
  type HostChatAnswer,
  type NewTabAgentMenuRow
} from '@/lib/new-tab-agent-menu-rows'
import {
  readLocalRuntimeCapabilityObservation,
  subscribeLocalRuntimeCapabilityObservation
} from '@/runtime/local-runtime-capabilities'
import {
  useDetectedAgents,
  type AgentDetectionTarget,
  type UseDetectedAgentsResult
} from '@/hooks/useDetectedAgents'
import { readDetectedAgentsForTarget } from '@/lib/agent-detection-target-inventory'
import { useChatProgramFacts } from '@/lib/host-chat-program-acquisition'
import { readChatProgram } from '@/lib/host-chat-program'
import { resolveAgentMenuSelection } from '@/lib/agent-menu-selection'
import { useHostAgentMenuSettings } from '@/components/settings/use-host-agent-launch-preferences'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { AgentLaunchSurface } from '@/lib/agent-session-launch-plan'

export type NewTabAgentMenuModel =
  | { state: 'loading'; placeholderCount: number }
  | {
      state: 'settled'
      rows: NewTabAgentMenuRow[]
      detection: UseDetectedAgentsResult
      /** The default these rows were ordered by, so the new-agent badge marks the same agent. */
      defaultTuiAgent?: GlobalSettings['defaultTuiAgent']
    }

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

/** A launch whose workspace may not exist yet, or that starts in a directory of its own. */
export type AgentMenuRowsTarget = {
  workspace: ProspectiveWorkspace
  /** Only a terminal can start here, so chat rows say so instead of dropping the directory. */
  launchCwd?: string | null
}

/** `detectionTarget` is the workspace's agent-inventory host, resolved by the caller. */
export function useNewTabAgentMenuRows(
  target: string | AgentMenuRowsTarget,
  open: boolean,
  detectionTarget: AgentDetectionTarget | undefined
): NewTabAgentMenuModel {
  return useAgentMenuObservation(target, open, detectionTarget).model
}

export function useAgentMenuObservation(
  target: string | AgentMenuRowsTarget | null,
  open: boolean,
  detectionTarget: AgentDetectionTarget | undefined
) {
  const worktreeId = typeof target === 'string' ? target : target?.workspace.worktreeId
  const launchCwd = typeof target === 'string' ? undefined : target?.launchCwd
  const unresolvedTarget = Boolean(worktreeId) && detectionTarget === undefined
  // Why: hidden worktrees stay mounted, so only the shown one holds its host's streams.
  const worktreeShown = useAppStore(
    (state) => typeof target === 'string' && state.activeWorktreeId === worktreeId
  )
  // Why: acquiring while the workspace is shown means the first open already knows its agents.
  const acquired = useDetectedAgents(open || worktreeShown ? detectionTarget : undefined)
  // Closing the menu or leaving the workspace must not erase the known inventory.
  const storedIds = useAppStore((state) =>
    detectionTarget ? readDetectedAgentsForTarget(state, detectionTarget) : null
  )
  // No owner means no agents to offer; a later owner publication resumes normal detection.
  const detection = {
    ...acquired,
    detectedIds: unresolvedTarget ? [] : (acquired.detectedIds ?? storedIds),
    isLoading: !unresolvedTarget && acquired.isLoading
  }
  useHostStructuredAgentsVersion()
  const localCapabilities = useSyncExternalStore(
    subscribeLocalRuntimeCapabilityObservation,
    readLocalRuntimeCapabilityObservation,
    readLocalRuntimeCapabilityObservation
  )
  const desktopSettings = useAppStore((state) => state.settings)
  const workspace =
    typeof target === 'string'
      ? { kind: workspaceKindForWorktreeId(target), worktreeId: target }
      : (target?.workspace ?? { kind: 'floating' as const })
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
  const { settings, pending: preferencesPending } = useHostAgentMenuSettings(
    unresolvedTarget ? null : facts,
    desktopSettings,
    open || worktreeShown,
    open
  )
  const chatEnabled = isNativeChatEnabled(settings)
  const plain = !chatEnabled || hostChatAnswer(input) === 'no-chats'
  const local = facts.executionHostId === LOCAL_EXECUTION_HOST_ID
  // Why a branch: a host publishing availability answers every agent from its one health snapshot;
  // an older host shows this client's facts, and the click's admission states the host's refusal.
  const published =
    input.hostCapabilities?.includes(AVAILABILITY) === true &&
    Boolean(structuredAgentSessionTargetForHost(facts.executionHostId))
  const availability = useHostStructuredAgentAvailability(
    published && !plain && !unresolvedTarget
      ? {
          executionHostId: facts.executionHostId,
          runtimeId: facts.runtimeId,
          pairingRevision: facts.pairingRevision,
          contact: facts.contact,
          hold: false
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
  const holding = (open || worktreeShown) && !plain && !unresolvedTarget
  useChatProgramFacts(workspace, holding)
  useChatProgramFacts({ kind: 'floating' }, holding && !local)
  // Only dependencies that can enable an action hold the cold fill; failed inventory ends its own.
  const loading =
    !unresolvedTarget &&
    (preferencesPending ||
      (detection.detectedIds === null && detectionTarget !== undefined && !inventoryFailed) ||
      (!plain &&
        (capabilityPending ||
          (!local && localAcquiring) ||
          availability?.state === 'pending' ||
          hostCatalogPending ||
          localCatalogPending)))
  const answerFor = (agent: TuiAgent): HostChatAnswer => {
    if (unresolvedTarget) {
      return 'not-yet-known'
    }
    const route = buildAgentLaunchRouteInput(state, {
      agent,
      workspace,
      ...(launchCwd ? { tuiCustomization: { cwd: launchCwd } } : {})
    })
    const preliminary = hostChatAnswer(roster ? { ...route, hostStructuredAgents: roster } : route)
    if (!roster || !['yes', 'not-yet-known', 'not-on-host'].includes(preliminary)) {
      return preliminary
    }
    const verdict =
      availability?.state === 'received' ? availability.byAgent.get(agent)?.state : undefined
    // An agent the host could not check keeps this client's facts; the click's admission decides.
    return !verdict || verdict === 'refused' ? 'not-on-host' : preliminary
  }
  const executionHostId = unresolvedTarget
    ? undefined
    : parseExecutionHostId(facts.executionHostId)?.id
  const rows = buildNewTabAgentMenuRows({
    settings,
    detectedOnHost: detection.detectedIds,
    chatAgents,
    chatProgram: (agent) =>
      unresolvedTarget ? 'unlearned' : readChatProgram(state, agent, input, detection.detectedIds),
    hostChatAnswer: answerFor
  }).map((row) => ({ ...row, executionHostId }))
  const model: NewTabAgentMenuModel = loading
    ? {
        state: 'loading',
        placeholderCount: Math.max(chatAgents.length, detection.detectedIds?.length ?? 0, 2)
      }
    : { state: 'settled', rows, detection, defaultTuiAgent: settings?.defaultTuiAgent }
  return {
    model,
    detection,
    contextKey: JSON.stringify([workspace, launchCwd, facts]),
    selectionFor: (agent: TuiAgent | null, surface?: AgentLaunchSurface) => {
      // A chat row can open through a host-run chat program; a terminal still needs the CLI.
      const chatRow = rows.some((row) => row.kind === 'chat' && row.agent === agent)
      const cliMissing =
        target !== null && !inventoryFailed && !!agent && !detection.detectedIds?.includes(agent)
      return resolveAgentMenuSelection({
        agent,
        surface,
        settings,
        executionHostId,
        inventoryReady:
          target === null ||
          (detectionTarget !== undefined &&
            !preferencesPending &&
            (inventoryFailed || (detection.detectedIds !== null && (!cliMissing || chatRow)))),
        cliMissing,
        answer:
          target === null
            ? 'no-chats'
            : inventoryFailed && !chatRow
              ? 'not-on-host'
              : agent === null
                ? 'yes'
                : answerFor(agent),
        chatPending:
          !unresolvedTarget &&
          !inventoryFailed &&
          (capabilityPending || availability?.state === 'pending' || hostCatalogPending),
        plain
      })
    }
  }
}
