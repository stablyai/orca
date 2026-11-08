import { useAppStateView, useAppStateViewActive } from '@/store/retained-views/app-state-view'
import { hostWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'
import { parseExecutionHostId } from '../../../../shared/execution-host'
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
import { callStructuredAgentSession } from '@/runtime/native-chat/requests/structured-agent-session-call'
import { readHostStructuredAgentsForRuntime } from '@/runtime/native-chat/agent-catalogs/host-structured-agents'
import { getAgentSessionOptionLaunchCatalog } from '../../../../shared/agent-session/options/agent-session-option-catalog'
import { formatAgentTypeLabel } from '../../../../shared/agent-status/presentation/agent-type-label'
import type { AgentSessionModelCatalogResult } from '../../../../shared/agent-session/agent-session-wire'
import { parseStructuredLaunchSeedOptions } from '../../../../shared/native-chat/input/native-chat-session-option-defaults'
import {
  createAgentPickerInventorySource,
  useAgentPickerInventoryEntries,
  currentAgentPickerAcquisition,
  observeAgentPickerAcquisition,
  type AgentPickerInventorySource
} from './agent-launch-picker-acquisition'
import {
  agentPickerChoiceSeeds,
  type AgentPickerDefaultSettings
} from '../../../../shared/agent-launch/picker/agent-launch-picker-defaults'
import { isAgentChatPermissionChoice } from '../../../../shared/agent-launch/permissions/agent-chat-permission-mode'
import {
  agentPickerEntriesFromRows,
  type AgentPickerEntry
} from '../../../../shared/agent-launch/picker/agent-launch-picker'

export { useAgentPickerInventoryEntries, type AgentPickerInventorySource }

/** Forms consume entries; menu owners can retain the source without subscribing. */
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

/** Owns acquisition for the menu without subscribing its caller to the entries it publishes. */
export function useAgentLaunchPickerInventorySource(
  worktreeId: string | undefined,
  model: NewTabAgentMenuModel,
  open: boolean,
  selected?: AgentPickerEntry['agent']
): AgentPickerInventorySource {
  const store = useAppStateView()
  const viewActive = useAppStateViewActive()
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
  const registeredAgents = readHostStructuredAgentsForRuntime(
    executionHostId,
    target?.kind === 'local' ? null : context?.runtimeId
  )
  const repo = context?.workspace.repoId
    ? store.getState().repos.find((candidate) => candidate.id === context.workspace.repoId)
    : undefined
  const workspaceId = worktreeId ?? context?.workspace.worktreeId
  const selector = workspaceId ? `id:${workspaceId}` : repo ? `path:${repo.path}` : undefined
  const state = store.getState()
  const hostId = parseExecutionHostId(executionHostId)?.id
  const worktrees = selectWorktreesByRepo(state)
  const folders = selectFolderWorkspaces(state)
  const concreteWorkspace = useMemo(
    () =>
      !!(
        workspaceId &&
        hostId &&
        selectWorkspaceByHostTarget(
          { worktreesByRepo: worktrees ?? {}, folderWorkspaces: folders ?? [] },
          hostWorktreeTarget({ id: workspaceId, hostId })
        )
      ),
    [workspaceId, hostId, worktrees, folders]
  )
  const draftTarget = useMemo(
    () => ({
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
    }),
    [
      context?.workspace.kind,
      workspaceId,
      context?.workspace.repoId,
      repo?.path,
      repo?.id,
      context?.launchCwd,
      context?.workspace.executionContext,
      executionHostId,
      concreteWorkspace
    ]
  )
  const key = useMemo(
    () =>
      JSON.stringify([
        context?.key,
        context?.workspace,
        context?.pairingRevision,
        context?.runtimeId,
        worktreeId,
        selector,
        executionHostId,
        model.state === 'settled' ? model.rows : [],
        model.state === 'settled' ? model.detection.detectedIds : [],
        model.state === 'settled' ? model.defaultTuiAgent : undefined,
        settings && {
          agentDefaultArgs: settings.agentDefaultArgs,
          agentLaunchChoices: settings.agentLaunchChoices,
          agentPermissionDefault: settings.agentPermissionDefault,
          agentPermissionOverrides: settings.agentPermissionOverrides,
          nativeChatSessionOptions: settings.nativeChatSessionOptions,
          nativeChatPermissionMode: settings.nativeChatPermissionMode
        }
      ]),
    [context, worktreeId, selector, executionHostId, model, settings]
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
          ...(!target ||
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
    if (!viewActive || !open || !target || model.state !== 'settled') {
      return
    }
    const controller = new AbortController()
    return observeAgentPickerAcquisition(
      key,
      fallback,
      {
        settings:
          target.kind !== 'environment'
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
        catalog: (entry, waitForListing) =>
          callStructuredAgentSession<AgentSessionModelCatalogResult>(
            target,
            'agentSession.modelCatalog',
            {
              ...(selector ? { worktree: selector } : {}),
              agent: entry.agent,
              ...(waitForListing ? { waitForListing } : {})
            }
          ),
        support: async (entry) => {
          if (!selector) {
            return undefined
          }
          const support = await callStructuredAgentSession<{
            seedOptions?: Record<string, string>
          }>(target, 'agentSession.createSupport', {
            worktree: selector,
            agent: entry.agent
          })
          const parsed = parseStructuredLaunchSeedOptions(support?.seedOptions)
          if (!parsed) {
            return undefined
          }
          const { model, permissionMode, ...options } = parsed
          return {
            ...(model ? { model } : {}),
            options,
            ...(isAgentChatPermissionChoice(permissionMode) ? { permissionMode } : {})
          }
        }
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
