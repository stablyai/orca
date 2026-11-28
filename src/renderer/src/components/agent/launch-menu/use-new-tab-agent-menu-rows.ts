import {
  createAgentMenuTerminalPendingSelector,
  useAgentMenuLaunchFacts
} from './agent-menu-launch-facts'
import { buildRouteInputForStatuses } from '@/lib/agent-session/launch/routing/agent-launch-route-input'
import {
  useAppViewExternalStore,
  useAppStateView,
  useAppStateViewActive,
  useAppStateValue
} from '@/store/retained-views/app-state-view'
import { nativeChatPreferenceFor } from '../../../../../shared/agent-launch/choices/structured-native-chat-launch-route'
import type { AgentMenuRowsTarget, NewTabAgentMenuModel } from './new-tab-agent-menu-model'

import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { readRuntimeStatusesForView } from '@/store/slices/runtime-status/views/runtime-status-owner'
import { useAppStateValueWithHostStatuses } from '@/store/slices/runtime-status/views/use-runtime-status-view'
import { STRUCTURED_AGENT_SESSION_AVAILABILITY_RUNTIME_CAPABILITY as AVAILABILITY } from '../../../../../shared/agent-session/capabilities/structured-agent-session-surface-capabilities'
import * as ExecutionHost from '../../../../../shared/execution-host/execution-host'
import { isTuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent-config'
import { useAgentPickerRefusedWake } from './use-agent-picker-refused-wake'
import { workspaceKindForWorktreeId } from '../../../../../shared/agent-launch/contracts/workspace-launch-kind'
import { useHostStructuredAgentsVersion } from '@/runtime/native-chat/agent-catalogs/chat-provider-agents'
import { structuredAgentSessionTargetForHost } from '@/runtime/native-chat/session-ownership/structured-agent-session-owner'
import {
  readHostStructuredAgents,
  hostStructuredAgentsCatalogUnlearned as catalogUnlearned
} from '@/runtime/native-chat/agent-catalogs/host-structured-agents'
import { useHostStructuredAgentAvailability } from '@/runtime/native-chat/agent-catalogs/use-host-structured-agent-availability'
import {
  buildNewTabAgentMenuRows,
  type HostChatAnswer
} from '../../../../../shared/agent-launch/picker/agent-launch-picker-rows'
import { hostChatAnswer } from '@/lib/agent-session/launch/routing/new-tab-agent-menu-rows'
import {
  readLocalRuntimeCapabilityObservation,
  subscribeLocalRuntimeCapabilityObservation
} from '@/runtime/hosts/capabilities/local-runtime-capabilities'
import { useDetectedAgents } from '@/lib/agent-session/launch/inventory/useDetectedAgents'
import type { AgentDetectionTarget } from '@/lib/agent-session/launch/inventory/useDetectedAgents'
import type { AgentMenuObservationOptions } from './agent-menu-observation-options'
import { readDetectedAgentsForTarget } from '@/lib/agent-session/launch/inventory/agent-detection-target-inventory'
import { useChatProgramFacts } from '@/lib/agent-session/launch/inventory/host-chat-program-acquisition'
import { readChatProgram } from '@/lib/agent-session/launch/inventory/host-chat-program'
import { resolveAgentMenuSelection } from '@/lib/agent-session/launch/routing/agent-menu-selection'
import { useHostAgentMenuSettings } from '@/runtime/agent-launch-settings/use-host-agent-launch-preferences'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import type { AgentLaunchSurface } from '@/lib/agent-session/launch/routing/agent-session-launch-plan'

/** `detectionTarget` is the workspace's agent-inventory host, resolved by the caller. */
export function useNewTabAgentMenuRows(
  target: string | AgentMenuRowsTarget,
  open: boolean,
  detectionTarget: AgentDetectionTarget | undefined,
  options?: AgentMenuObservationOptions
): NewTabAgentMenuModel {
  // Only the new-tab menu opens setup chats; pickers that save an agent need one that runs.
  const observationOptions = { ...options, offerAgentSetup: true }
  return useAgentMenuObservation(target, open, detectionTarget, observationOptions).model
}

export type { AgentMenuObservationOptions }

export function useAgentMenuObservation(
  target: string | AgentMenuRowsTarget | null,
  open: boolean,
  detectionTarget: AgentDetectionTarget | undefined,
  options?: AgentMenuObservationOptions
) {
  const state = useAppStateView().getState()
  const hostStatuses = readRuntimeStatusesForView(useAppStateView())
  const viewActive = useAppStateViewActive()
  const worktreeId = typeof target === 'string' ? target : target?.workspace.worktreeId
  const launchCwd = typeof target === 'string' ? undefined : target?.launchCwd
  const unresolvedTarget = Boolean(worktreeId) && detectionTarget === undefined
  // Why: hidden worktrees stay mounted, so only the shown one holds its host's streams.
  const shown = useAppStateValue(
    (state) => typeof target === 'string' && state.activeWorktreeId === worktreeId
  )
  // Why: acquiring while the workspace is shown means the first open already knows its agents.
  const acquireTarget = viewActive && (open || shown) ? detectionTarget : undefined
  const acquired = useDetectedAgents(acquireTarget, 'enabled', options?.observationGroup)
  useAgentPickerRefusedWake(viewActive && options?.wakeOnOpen === true && open, detectionTarget)
  // Closing the menu or leaving the workspace must not erase the known inventory.
  const storedIds = useAppStateValue((state) =>
    detectionTarget ? readDetectedAgentsForTarget(state, detectionTarget) : null
  )
  // No owner means no agents to offer; a later owner publication resumes normal detection.
  const detection = {
    ...acquired,
    detectedIds: unresolvedTarget ? [] : (acquired.detectedIds ?? storedIds),
    isLoading: !unresolvedTarget && acquired.isLoading
  }
  useHostStructuredAgentsVersion()
  const localCapabilities = useAppViewExternalStore(
    subscribeLocalRuntimeCapabilityObservation,
    readLocalRuntimeCapabilityObservation,
    readLocalRuntimeCapabilityObservation
  )
  // The observation owns these settings; picker consumers reuse its snapshot.
  const desktopSettings = state.settings
  const workspace =
    typeof target === 'string'
      ? { kind: workspaceKindForWorktreeId(target), worktreeId: target }
      : (target?.workspace ?? { kind: 'floating' as const })
  const facts = useAgentMenuLaunchFacts(workspace)
  const prospective = typeof target === 'string' ? undefined : target?.workspace
  const repoId = prospective?.repoId
  const repoHostId = prospective?.executionHostId
  const terminalPendingSelector = useMemo(
    () =>
      createAgentMenuTerminalPendingSelector({ worktreeId, repoId, executionHostId: repoHostId }),
    [worktreeId, repoId, repoHostId]
  )
  const terminalPending = useAppStateValueWithHostStatuses(terminalPendingSelector)
  const input = buildRouteInputForStatuses(state, hostStatuses, { agent: 'claude', workspace })
  const hostPreferences = useHostAgentMenuSettings(
    unresolvedTarget ? null : facts,
    desktopSettings,
    viewActive && (open || shown),
    viewActive && open
  )
  const { settings, pending: preferencesPending } = hostPreferences
  useAppStateValue(
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
  const local = facts.executionHostId === ExecutionHost.LOCAL_EXECUTION_HOST_ID
  // Use published host-wide availability when supported; older hosts defer final admission to the launch request.
  const published =
    input.hostCapabilities?.includes(AVAILABILITY) === true &&
    Boolean(structuredAgentSessionTargetForHost(facts.executionHostId))
  const availability = useHostStructuredAgentAvailability(
    viewActive && published && !plain && !unresolvedTarget
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
      : readHostStructuredAgents(ExecutionHost.LOCAL_EXECUTION_HOST_ID, hostStatuses)?.map(
          ({ agent }) => agent
        )
  const hostCatalog =
    roster ??
    readHostStructuredAgents(facts.executionHostId, hostStatuses)?.map(({ agent }) => agent)
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
      ExecutionHost.LOCAL_EXECUTION_HOST_ID,
      null,
      localCapabilities.state === 'known' ? localCapabilities.capabilities : null
    )
  const holding = viewActive && (open || shown) && !plain && !unresolvedTarget
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
    if (!answerContext) {
      const tui = launchCwd ? { tuiCustomization: { cwd: launchCwd } } : {}
      answerContext = buildRouteInputForStatuses(state, hostStatuses, { agent, workspace, ...tui })
    }
    const route = { ...answerContext, agent }
    const preliminary = hostChatAnswer(roster ? { ...route, hostStructuredAgents: roster } : route)
    if (!roster || !['yes', 'not-yet-known', 'not-on-host'].includes(preliminary)) {
      return preliminary
    }
    const published =
      availability?.state === 'received' ? availability.byAgent.get(agent) : undefined
    if (published?.state === 'refused') {
      const r = published.reason
      return r === 'windows' || r === 'too-old' ? r : 'not-on-host'
    }
    return published ? preliminary : 'not-on-host'
  }
  const executionHostId = unresolvedTarget
    ? undefined
    : ExecutionHost.parseExecutionHostId(facts.executionHostId)?.id
  const { detectedIds } = detection
  const rows = buildNewTabAgentMenuRows({
    settings,
    detectedOnHost: detectedIds,
    chatAgents,
    chatProgram: (agent) =>
      unresolvedTarget ? 'unlearned' : readChatProgram(hostStatuses, agent, input, detectedIds),
    hostChatAnswer: answerFor,
    offerAgentSetup: options?.offerAgentSetup,
    hostPlatform: facts.hostPlatform
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
        terminalPending,
        pickerContext: {
          workspace,
          launchCwd,
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
    preferencesInherited: hostPreferences.inherited,
    detection,
    contextKey: JSON.stringify([workspace, launchCwd, facts]),
    selectionFor: (
      agent: TuiAgent | null,
      surface?: AgentLaunchSurface,
      preferredSurface?: 'chat'
    ) => {
      // A chat row can open through a host-run chat program; a terminal still needs the CLI.
      const chatRow = rows.some((row) => row.kind === 'chat' && row.agent === agent)
      const cliMissing =
        target !== null && !inventoryFailed && !!agent && !detection.detectedIds?.includes(agent)
      const selection = resolveAgentMenuSelection({
        agent,
        surface,
        preferredSurface,
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
      const terminalWaiting =
        selection.ready && terminalPending && selection.choice?.route === 'terminal-tui'
      return { ...selection, ready: selection.ready && !terminalWaiting, terminalWaiting }
    }
  }
}
