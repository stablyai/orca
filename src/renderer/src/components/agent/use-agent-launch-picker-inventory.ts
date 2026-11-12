import { getAgentSessionOptionLaunchCatalog } from '../../../../shared/agent-session/options/agent-session-option-catalog'
import { recomputeOn } from '@/lib/recompute-on'
import { useHostStructuredAgentsVersion } from '@/runtime/native-chat/agent-catalogs/chat-provider-agents'
import {
  createAgentPickerInventorySource,
  useAgentPickerInventoryEntries,
  type AgentPickerInventorySource
} from './agent-picker-inventory-source'
import {
  useAppStateView,
  useAppStateViewActive,
  useAppViewExternalStore
} from '@/store/retained-views/app-state-view'
import {
  readLocalRuntimeCapabilityObservation,
  subscribeLocalRuntimeCapabilityObservation
} from '@/runtime/hosts/capabilities/local-runtime-capabilities'
import { hostWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../../shared/execution-host'
import { selectWorkspaceByHostTarget } from '@/store/workspaces/selection/workspace-host-target'
import {
  selectWorktreesByRepo,
  selectFolderWorkspaces
} from '@/store/workspaces/catalog/workspace-record-fields'
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { readHostAgentLaunchDefaults } from '../../runtime/agent-launch-settings/agent-launch-settings-transport'
import type { NewTabAgentMenuModel } from '../tab-bar/use-new-tab-agent-menu-rows'
import { buildAgentLaunchRouteInput } from '@/lib/agent-session/launch/routing/agent-launch-route-input'
import { workspaceKindForWorktreeId } from '../../../../shared/agent-launch/contracts/workspace-launch-kind'
import { structuredAgentSessionTargetForHost } from '@/runtime/native-chat/session-ownership/structured-agent-session-owner'
import { readHostStructuredAgentsForRuntime } from '@/runtime/native-chat/agent-catalogs/host-structured-agents'
import { agentPickerListsCliModels } from './agent-launch-picker-cli-model-catalog'
import {
  agentPickerModelCatalogReads,
  agentPickerCatalogSettingsKey,
  agentPickerTerminalDiscovery,
  agentPickerCliDiscoveryRuntime,
  readAgentPickerLaunchSupport
} from './agent-launch-picker-host-reads'
import { AGENT_SESSION_COHERENT_MODEL_CATALOG_CAPABILITY } from '../../../../shared/agent-session/structured-agent-session-surface-capabilities'
import { formatAgentTypeLabel } from '../../../../shared/agent-status/presentation/agent-type-label'
import {
  currentAgentPickerAcquisition,
  observeAgentPickerAcquisition
} from './agent-launch-picker-acquisition'
import {
  agentPickerChoiceSeeds,
  type AgentPickerDefaultSettings
} from '../../../../shared/agent-launch/picker/agent-launch-picker-defaults'
import {
  agentPickerEntriesFromRows,
  type AgentPickerEntry
} from '../../../../shared/agent-launch/picker/agent-launch-picker'

export { useAgentPickerInventoryEntries, type AgentPickerInventorySource }
export function useAgentLaunchPickerInventory(
  worktreeId: string | undefined,
  model: NewTabAgentMenuModel,
  open: boolean,
  selected?: AgentPickerEntry['agent']
): AgentPickerEntry[] {
  return useAgentPickerInventoryEntries(
    useAgentLaunchPickerInventorySource(worktreeId, model, open, selected)
  )
}
export function useAgentLaunchPickerInventorySource(
  worktreeId: string | undefined,
  model: NewTabAgentMenuModel,
  open: boolean,
  selected?: AgentPickerEntry['agent']
): AgentPickerInventorySource {
  const store = useAppStateView()
  const viewActive = useAppStateViewActive()
  const localCapabilities = useAppViewExternalStore(
    subscribeLocalRuntimeCapabilityObservation,
    readLocalRuntimeCapabilityObservation,
    readLocalRuntimeCapabilityObservation
  )
  const selectedRef = useRef(selected)
  useLayoutEffect(() => {
    selectedRef.current = selected
  }, [selected])
  const context = model.state === 'settled' ? model.pickerContext : undefined
  const settings = context ? context.settings : store.getState().settings
  const executionHostId =
    context?.executionHostId ??
    buildAgentLaunchRouteInput(store.getState(), {
      agent: 'claude',
      workspace: context?.workspace ?? {
        kind: worktreeId ? workspaceKindForWorktreeId(worktreeId) : 'floating',
        ...(worktreeId ? { worktreeId } : {})
      }
    }).executionHostId
  const target = structuredAgentSessionTargetForHost(executionHostId)
  const agentsVersion = useHostStructuredAgentsVersion()
  const registeredAgents = recomputeOn(
    [agentsVersion, executionHostId, target?.kind, context?.runtimeId],
    () =>
      readHostStructuredAgentsForRuntime(
        executionHostId,
        target?.kind === 'local' ? null : context?.runtimeId
      )
  )
  const repo = context?.workspace.repoId
    ? store
        .getState()
        .repos.find(
          (candidate) =>
            candidate.id === context.workspace.repoId &&
            getRepoExecutionHostId(candidate) === executionHostId
        )
    : undefined
  const workspaceId = worktreeId ?? context?.workspace.worktreeId
  const selector = workspaceId ? `id:${workspaceId}` : repo ? `path:${repo.path}` : undefined
  const state = store.getState()
  const hostId = parseExecutionHostId(executionHostId)?.id
  const worktrees = selectWorktreesByRepo(state)
  const folders = selectFolderWorkspaces(state)
  const selectedWorkspace = useMemo(
    () =>
      workspaceId &&
      hostId &&
      selectWorkspaceByHostTarget(
        { worktreesByRepo: worktrees ?? {}, folderWorkspaces: folders ?? [] },
        hostWorktreeTarget({ id: workspaceId, hostId })
      ),
    [workspaceId, hostId, worktrees, folders]
  )
  const concreteWorkspace = !!selectedWorkspace
  const hostCapabilities =
    target?.kind === 'local'
      ? localCapabilities.state === 'known'
        ? localCapabilities.capabilities
        : null
      : buildAgentLaunchRouteInput(state, {
          agent: 'claude',
          workspace: context?.workspace ?? {
            kind: worktreeId ? workspaceKindForWorktreeId(worktreeId) : 'floating',
            ...(worktreeId ? { worktreeId } : {})
          }
        }).hostCapabilities
  const coherentCatalog =
    hostCapabilities?.includes(AGENT_SESSION_COHERENT_MODEL_CATALOG_CAPABILITY) === true
  const draftTarget = {
    key: JSON.stringify([
      context?.workspace.kind,
      workspaceId,
      context?.workspace.repoId,
      repo?.path,
      context?.launchCwd,
      context?.workspace.executionContext,
      executionHostId
    ]),
    worktreeId: concreteWorkspace ? workspaceId : undefined,
    repoId: repo?.id,
    executionHostId
  }
  const discoveryWorktreeId = draftTarget.worktreeId ?? null
  const cliDiscoveryRuntime = agentPickerCliDiscoveryRuntime(
    store.getState(),
    discoveryWorktreeId,
    target,
    repo?.path
  )
  const terminalDiscovery = agentPickerTerminalDiscovery({
    target,
    concreteWorkspace,
    workspaceId,
    repo,
    cwd: context?.launchCwd
  })
  const reads = agentPickerModelCatalogReads({
    target,
    worktree: selector,
    cliDiscoveryRuntime,
    terminalDiscovery
  })
  const observesHostCatalog =
    model.state === 'settled' && model.rows.some(reads.refreshOnInvalidation)
  const key = useMemo(
    () =>
      JSON.stringify([
        context?.key,
        context?.workspace,
        context?.pairingRevision,
        context?.runtimeId,
        ...(observesHostCatalog ? [registeredAgents, coherentCatalog] : []),
        worktreeId,
        selector,
        executionHostId,
        model.state === 'settled' ? model.rows : [],
        model.state === 'settled' ? model.detection.detectedIds : [],
        model.state === 'settled' ? model.defaultTuiAgent : undefined,
        agentPickerCatalogSettingsKey(settings, state.settings)
      ]),
    [
      context,
      worktreeId,
      selector,
      executionHostId,
      model,
      settings,
      state.settings,
      registeredAgents,
      coherentCatalog,
      observesHostCatalog
    ]
  )
  const build = (defaults: AgentPickerDefaultSettings | null | undefined) =>
    model.state === 'settled'
      ? agentPickerEntriesFromRows(
          model.rows,
          model.detection.detectedIds ?? [],
          (agent) => agentPickerChoiceSeeds(agent, defaults),
          formatAgentTypeLabel,
          model.defaultTuiAgent
        ).map((entry) => ({
          ...entry,
          coherentCatalog,
          ...((!target && !(cliDiscoveryRuntime && agentPickerListsCliModels(entry))) ||
          !entry.surfaces.length ||
          (registeredAgents &&
            !registeredAgents.some(({ agent }) => agent === entry.agent) &&
            !getAgentSessionOptionLaunchCatalog(entry.agent))
            ? { catalogRead: 'unsupported' as const }
            : {})
        }))
      : []
  const fallback = useMemo(
    () =>
      target?.kind === 'environment'
        ? build({}).map((entry) => ({
            ...entry,
            terminal: {},
            structured: {},
            arguments: undefined,
            defaultsPending: true,
            structuredDefaultsPending: entry.surfaces.includes('chat'),
            ownerKey: key,
            draftTarget,
            worktreeId
          }))
        : build(settings).map((entry) => ({ ...entry, ownerKey: key, draftTarget, worktreeId })),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- The semantic key covers rows, detection, target and defaults without restarting for object identity.
    [key]
  )
  // A new generation starts from the shared acquisition (or the fallback) until it publishes.
  const source = useMemo(
    () =>
      createAgentPickerInventorySource(
        (open ? currentAgentPickerAcquisition(key) : undefined) ?? fallback
      ),
    [key, open, fallback]
  )
  useEffect(() => {
    if (!viewActive || !open || (!target && !cliDiscoveryRuntime) || model.state !== 'settled') {
      return
    }
    const controller = new AbortController()
    return observeAgentPickerAcquisition(
      key,
      fallback,
      {
        settings:
          target?.kind !== 'environment'
            ? undefined
            : async () => {
                const defaults = await readHostAgentLaunchDefaults(
                  {
                    environmentId: target.environmentId,
                    pairingRevision: context?.pairingRevision,
                    ...(context?.runtimeId ? { runtimeId: context.runtimeId } : {})
                  },
                  controller.signal
                ).catch(() => null)
                return defaults
                  ? build(defaults.settings).map((entry) => ({
                      ...entry,
                      defaultsPending: false,
                      structuredDefaultsPending:
                        entry.surfaces.includes('chat') && !defaults.structuredKnown,
                      ownerKey: key,
                      draftTarget,
                      worktreeId
                    }))
                  : undefined
              },
        ...reads,
        subscribeInvalidation: observesHostCatalog ? reads.subscribeInvalidation : undefined,
        support: (entry) => readAgentPickerLaunchSupport(target, selector, entry.agent)
      },
      {
        selected: () => selectedRef.current,
        publish: source.publish
      }
    )
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Only semantic inputs and visibility own observation; selected priority publishes independently after commit.
  }, [key, open, source, viewActive])
  return source
}
