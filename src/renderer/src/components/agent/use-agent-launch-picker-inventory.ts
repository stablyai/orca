import { hostWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import {
  selectWorkspaceByHostTarget,
  selectWorktreesByRepo,
  selectFolderWorkspaces
} from '@/store/workspace-record-selectors'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { readHostAgentLaunchSettings } from '../settings/agent-launch-settings-transport'
import type { NewTabAgentMenuModel } from '../tab-bar/use-new-tab-agent-menu-rows'
import { useAppStore } from '@/store'
import {
  buildAgentLaunchRouteInput,
  workspaceKindForWorktreeId
} from '@/lib/agent-launch-route-input'
import { structuredAgentSessionTargetForHost } from '@/runtime/structured-agent-session-owner'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { readHostStructuredAgentsForRuntime } from '@/runtime/host-structured-agents'
import { getAgentSessionOptionLaunchCatalog } from '../../../../shared/agent-session-option-catalog'
import { formatAgentTypeLabel } from '../../../../shared/agent-type-label'
import type { AgentSessionModelCatalogResult } from '../../../../shared/agent-session-wire'
import { parseStructuredLaunchSeedOptions } from '../../../../shared/native-chat/input/native-chat-session-option-defaults'
import {
  currentAgentPickerAcquisition,
  observeAgentPickerAcquisition
} from './agent-launch-picker-acquisition'
import { isAgentPermissionChoice } from '../../../../shared/tui-agent-permission-choice'
import { isAgentChatPermissionChoice } from '../../../../shared/agent-chat-permission-mode'
import {
  agentPickerEntriesFromRows,
  agentPickerChoiceSeeds,
  type AgentPickerDefaultSettings,
  type AgentPickerEntry
} from '../../../../shared/agent-launch-picker'

export function useAgentLaunchPickerInventory(
  worktreeId: string | undefined,
  model: NewTabAgentMenuModel,
  open: boolean,
  selected?: AgentPickerEntry['agent']
): AgentPickerEntry[] {
  const selectedRef = useRef(selected)
  useLayoutEffect(() => {
    selectedRef.current = selected
  }, [selected])
  const context = model.state === 'settled' ? model.pickerContext : undefined
  const settings = context ? context.settings : useAppStore.getState().settings
  const executionHostId =
    context?.executionHostId ??
    buildAgentLaunchRouteInput(useAppStore.getState(), {
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
    ? useAppStore.getState().repos.find((candidate) => candidate.id === context.workspace.repoId)
    : undefined
  const workspaceId = worktreeId ?? context?.workspace.worktreeId
  const selector = workspaceId ? `id:${workspaceId}` : repo ? `path:${repo.path}` : undefined
  const state = useAppStore.getState()
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
  const generation = useMemo(() => ({ key, open }), [key, open])
  const [snapshot, setSnapshot] = useState<{
    generation: object
    entries: AgentPickerEntry[]
  } | null>(null)
  const build = (defaults: AgentPickerDefaultSettings | null | undefined) =>
    model.state === 'settled'
      ? agentPickerEntriesFromRows(
          model.rows,
          model.detection.detectedIds ?? [],
          (agent) => agentPickerChoiceSeeds(agent, defaults),
          formatAgentTypeLabel
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
            draftTarget
          }))
        : build(settings).map((entry) => ({ ...entry, ownerKey: key, draftTarget })),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- The semantic key covers rows, detection, target and defaults without restarting for object identity.
    [key]
  )
  useEffect(() => {
    if (!open || !target || model.state !== 'settled') {
      return
    }
    const controller = new AbortController()
    const record = (value: unknown): value is Record<string, unknown> =>
      value !== null && typeof value === 'object' && !Array.isArray(value)
    const argsRecord = (value: unknown) =>
      value === undefined ||
      (record(value) && Object.values(value).every((v) => typeof v === 'string'))
    const permissionsRecord = (value: unknown) =>
      value === undefined || (record(value) && Object.values(value).every(isAgentPermissionChoice))
    const usable = (value: unknown): value is AgentPickerDefaultSettings =>
      record(value) &&
      argsRecord(value.agentDefaultArgs) &&
      permissionsRecord(value.agentPermissionOverrides) &&
      (value.agentPermissionDefault === undefined ||
        isAgentPermissionChoice(value.agentPermissionDefault)) &&
      (value.agentPermission === undefined ||
        (record(value.agentPermission) &&
          isAgentPermissionChoice(value.agentPermission.default) &&
          argsRecord(value.agentPermission.userArgs) &&
          permissionsRecord(value.agentPermission.overrides)))
    return observeAgentPickerAcquisition(
      key,
      fallback,
      {
        settings:
          target.kind !== 'environment'
            ? undefined
            : async () => {
                const host = await readHostAgentLaunchSettings(
                  {
                    environmentId: target.environmentId,
                    pairingRevision: context?.pairingRevision,
                    ...(context?.runtimeId ? { runtimeId: context.runtimeId } : {})
                  },
                  controller.signal
                ).catch(() => null)
                let defaults: AgentPickerDefaultSettings | undefined
                let structuredKnown = false
                if (usable(host)) {
                  const permission = host.agentPermission
                  const choices = host.agentChoices
                  defaults = {
                    agentDefaultArgs:
                      choices?.userArgs ?? permission?.userArgs ?? host.agentDefaultArgs,
                    agentLaunchChoices: choices?.defaults ?? settings?.agentLaunchChoices,
                    ...(permission
                      ? {
                          agentPermissionDefault: permission.default,
                          agentPermissionOverrides: permission.overrides
                        }
                      : {})
                  }
                } else {
                  const legacy = await callRuntimeRpc<{ settings?: AgentPickerDefaultSettings }>(
                    target,
                    'settings.get',
                    undefined,
                    {
                      signal: controller.signal,
                      timeoutMs: 15_000,
                      expectedEnvironmentPairingRevision: context?.pairingRevision,
                      ...(context?.runtimeId
                        ? { expectedEnvironmentRuntimeId: context.runtimeId }
                        : {})
                    }
                  ).catch(() => null)
                  if (usable(legacy?.settings)) {
                    defaults = legacy.settings
                    structuredKnown = true
                  }
                }
                return defaults
                  ? build(defaults).map((entry) => ({
                      ...entry,
                      defaultsPending: false,
                      structuredDefaultsPending:
                        entry.surfaces.includes('chat') && !structuredKnown,
                      ownerKey: key,
                      draftTarget
                    }))
                  : undefined
              },
        catalog: async (entry) =>
          await callStructuredAgentSession<AgentSessionModelCatalogResult>(
            target,
            'agentSession.modelCatalog',
            {
              ...(selector ? { worktree: selector } : {}),
              agent: entry.agent,
              waitForListing: true
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
        publish: (entries) => setSnapshot({ generation, entries: [...entries] })
      }
    )
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Only semantic inputs and visibility own observation; selected priority publishes independently after commit.
  }, [key, open])
  return snapshot?.generation === generation
    ? snapshot.entries
    : ((open ? currentAgentPickerAcquisition(key) : undefined) ?? fallback)
}
