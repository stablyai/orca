import { nativeChatPreferenceFor } from '../../../../shared/structured-native-chat-launch-route'
import type { AgentMenuRowsTarget, NewTabAgentMenuModel } from './new-tab-agent-menu-model'
export type { AgentMenuRowsTarget, NewTabAgentMenuModel } from './new-tab-agent-menu-model'
import { useSyncExternalStore } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { STRUCTURED_AGENT_SESSION_AVAILABILITY_RUNTIME_CAPABILITY as AVAILABILITY } from '../../../../shared/protocol-version'
import { LOCAL_EXECUTION_HOST_ID, parseExecutionHostId } from '../../../../shared/execution-host'
import { lastVerifiedRuntimeStatus } from '../../../../shared/runtime-host-status'
import {
  isRuntimeHostContactRevokedVerdict,
  runtimeHostContactForEntry
} from '../../../../shared/runtime-host-contact'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import { useAppStore } from '@/store'
import { useAgentPickerRefusedWake } from './use-agent-picker-refused-wake'
import {
  buildAgentLaunchRouteInput,
  workspaceKindForWorktreeId
} from '@/lib/agent-launch-route-input'
import { useHostStructuredAgentsVersion } from '@/lib/chat-provider-agents'
import { structuredAgentSessionTargetForHost } from '@/runtime/structured-agent-session-owner'
import {
  readHostStructuredAgents,
  hostStructuredAgentsCatalogUnlearned as catalogUnlearned
} from '@/runtime/host-structured-agents'
import { getRuntimeEnvironmentRevision } from '@/runtime/runtime-environment-revision'
import { useHostStructuredAgentAvailability } from '@/runtime/use-host-structured-agent-availability'
import {
  buildNewTabAgentMenuRows,
  hostChatAnswer,
  type HostChatAnswer
} from '@/lib/new-tab-agent-menu-rows'
import {
  readLocalRuntimeCapabilityObservation,
  subscribeLocalRuntimeCapabilityObservation
} from '@/runtime/local-runtime-capabilities'
import { useDetectedAgents, type AgentDetectionTarget } from '@/hooks/useDetectedAgents'
import { readDetectedAgentsForTarget } from '@/lib/agent-detection-target-inventory'
import { useChatProgramFacts } from '@/lib/host-chat-program-acquisition'
import { readChatProgram } from '@/lib/host-chat-program'
import { resolveAgentMenuSelection } from '@/lib/agent-menu-selection'
import { useHostAgentMenuSettings } from '@/components/settings/use-host-agent-launch-preferences'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { AgentLaunchSurface } from '@/lib/agent-session-launch-plan'

/** `detectionTarget` is the workspace's agent-inventory host, resolved by the caller. */
export function useNewTabAgentMenuRows(
  target: string | AgentMenuRowsTarget,
  open: boolean,
  detectionTarget: AgentDetectionTarget | undefined,
  options?: AgentMenuObservationOptions
): NewTabAgentMenuModel {
  return useAgentMenuObservation(target, open, detectionTarget, options).model
}

/** `wakeOnOpen`: `open` is the user opening this picker, a user act that may start its WSL distro. */
export type AgentMenuObservationOptions = { wakeOnOpen?: boolean }

export function useAgentMenuObservation(
  target: string | AgentMenuRowsTarget | null,
  open: boolean,
  detectionTarget: AgentDetectionTarget | undefined,
  options?: AgentMenuObservationOptions
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
  useAgentPickerRefusedWake(options?.wakeOnOpen === true && open, detectionTarget)
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
  // The observation owns these settings; picker consumers reuse its snapshot.
  const desktopSettings = useAppStore.getState().settings
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
        contact: `${status?.connectionGeneration}:${status?.hostContactEpoch}:${isRuntimeHostContactRevokedVerdict(contact)}`,
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
  useAppStore(
    useShallow((state) => [
      state.settings?.defaultTuiAgent,
      state.settings?.disabledTuiAgents,
      state.settings?.agentDefaultSurface,
      state.settings?.nativeChatProviders,
      state.settings?.agentDefaultArgs,
      state.settings?.agentPermissionDefault,
      state.settings?.agentPermissionOverrides,
      state.settings?.nativeChatSessionOptions,
      settings?.agentLaunchChoices === desktopSettings?.agentLaunchChoices
        ? state.settings?.agentLaunchChoices
        : undefined,
      state.settings?.nativeChatPermissionMode
    ])
  )
  const plain = hostChatAnswer(input) === 'no-chats'
  const local = facts.executionHostId === LOCAL_EXECUTION_HOST_ID
  // Use published host-wide availability when supported; older hosts defer final admission to the launch request.
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
        .filter((agent) => nativeChatPreferenceFor(settings, agent))
    ])
  ].filter(isTuiAgent)
  const inventoryFailed =
    detection.detectedIds === null && (detection.detectionFailed || detection.needsServerUpdate)
  const localAcquiring = ['unlearned', 'pending'].includes(localCapabilities.state)
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
  // Workspace preparation is shared by answers, while agent and published verdict stay per question.
  let answerContext = launchCwd ? undefined : input
  const answerFor = (agent: TuiAgent): HostChatAnswer => {
    if (unresolvedTarget) {
      return 'not-yet-known'
    }
    answerContext ??= buildAgentLaunchRouteInput(state, {
      agent,
      workspace,
      ...(launchCwd ? { tuiCustomization: { cwd: launchCwd } } : {})
    })
    const route = { ...answerContext, agent }
    const preliminary = hostChatAnswer(roster ? { ...route, hostStructuredAgents: roster } : route)
    if (!roster || !['yes', 'not-yet-known', 'not-on-host'].includes(preliminary)) {
      return preliminary
    }
    const verdict =
      availability?.state === 'received' ? availability.byAgent.get(agent)?.state : undefined
    // Missing/refused published availability overrides a preliminary route that would otherwise allow launch.
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
    : {
        state: 'settled',
        rows,
        detection,
        defaultTuiAgent: settings?.defaultTuiAgent,
        pickerContext: {
          workspace,
          executionHostId: facts.executionHostId,
          pairingRevision: facts.pairingRevision,
          runtimeId: facts.runtimeId,
          settings,
          key: JSON.stringify([workspace, launchCwd, facts])
        }
      }
  const { defaultTuiAgent, disabledTuiAgents, agentLaunchChoices } = settings ?? {}
  return {
    model,
    preferences: { defaultTuiAgent, disabledTuiAgents, agentLaunchChoices },
    preferencesPending,
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
