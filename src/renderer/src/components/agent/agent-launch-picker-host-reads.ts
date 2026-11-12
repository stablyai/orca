import { useMemo } from 'react'
import { useAppStateValue } from '@/store/retained-views/app-state-view'
import { structuredAgentSessionTargetForHost } from '@/runtime/native-chat/session-ownership/structured-agent-session-owner'
import type { AgentPickerDefaultSettings } from '../../../../shared/agent-launch/picker/agent-launch-picker-defaults'
import { resolveWorktreeModelDiscoveryRuntime } from '../native-chat/session/options/catalog/native-chat-session-option-discovery'
import {
  createTerminalModelDiscoveryKeySelector,
  readAntigravityTerminalCatalog,
  terminalModelDiscoveryDescriptor,
  type TerminalModelDiscoveryDescriptor
} from '@/runtime/terminal/terminal-model-discovery-client'
import type { AppState } from '@/store/types'
import type { AgentSessionModelCatalogResult } from '../../../../shared/agent-session/agent-session-wire'
import type { RuntimeGitContext } from '@/runtime/source-control/git/runtime-git-client-context'
import {
  agentPickerListsCliModels,
  readAgentPickerCliModelCatalog
} from './agent-launch-picker-cli-model-catalog'
import { callStructuredAgentSession } from '@/runtime/native-chat/requests/structured-agent-session-call'
import {
  readModelMenuCatalog,
  type ModelMenuReadScope
} from '@/runtime/native-chat/model-catalogs/model-menu-catalog-read'
import { subscribeModelMenuInvalidation } from '@/runtime/native-chat/model-catalogs/model-menu-invalidation'
import { parseStructuredLaunchSeedOptions } from '../../../../shared/native-chat/input/native-chat-session-option-defaults'
import { isAgentChatPermissionChoice } from '../../../../shared/agent-launch/permissions/agent-chat-permission-mode'
import type { AgentPickerEntry } from '../../../../shared/agent-launch/picker/agent-launch-picker'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'

export function agentPickerModelCatalogReads(
  input: Omit<ModelMenuReadScope, 'agent' | 'target'> & {
    target: RuntimeClientTarget | null
    cliDiscoveryRuntime?: RuntimeGitContext | null
    terminalDiscovery?: TerminalModelDiscoveryDescriptor | null
  }
) {
  const { target, cliDiscoveryRuntime } = input
  return {
    catalog: async (
      entry: AgentPickerEntry,
      waitForListing: boolean,
      signal: AbortSignal,
      surface?: 'terminal'
    ) =>
      surface === 'terminal' && entry.agent === 'antigravity'
        ? !input.terminalDiscovery
          ? { origin: 'unknown' as const }
          : readAntigravityTerminalCatalog(
              input.terminalDiscovery.runtime,
              input.terminalDiscovery.launch
            )
        : cliDiscoveryRuntime && agentPickerListsCliModels(entry)
          ? readAgentPickerCliModelCatalog(entry.agent, cliDiscoveryRuntime)
          : !target
            ? undefined
            : entry.agent === 'antigravity'
              ? callStructuredAgentSession<AgentSessionModelCatalogResult>(
                  target,
                  'agentSession.modelCatalog',
                  {
                    ...(input.worktree ? { worktree: input.worktree } : {}),
                    agent: entry.agent,
                    ...(waitForListing ? { waitForListing } : {})
                  }
                )
              : readModelMenuCatalog(
                  { ...input, target, agent: entry.agent },
                  waitForListing,
                  signal
                ),
    refreshOnInvalidation: (entry: Pick<AgentPickerEntry, 'agent'>) =>
      !!target &&
      !(cliDiscoveryRuntime && agentPickerListsCliModels(entry)) &&
      entry.agent !== 'antigravity',
    subscribeInvalidation: target
      ? (listener: () => void) => subscribeModelMenuInvalidation(target, listener)
      : undefined
  }
}

export async function readAgentPickerLaunchSupport(
  target: RuntimeClientTarget | null,
  selector: string | undefined,
  agent: AgentPickerEntry['agent']
): Promise<AgentPickerEntry['structured'] | undefined> {
  if (!selector || !target) {
    return undefined
  }
  const support = await callStructuredAgentSession<{ seedOptions?: Record<string, string> }>(
    target,
    'agentSession.createSupport',
    { worktree: selector, agent }
  )
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

export function agentPickerTerminalDiscovery(
  state: AppState,
  input: {
    target: RuntimeClientTarget | null
    concreteWorkspace: boolean
    workspaceId?: string
    repo?: { id: string; executionHostId?: string | null }
    cwd?: string | null
  }
): TerminalModelDiscoveryDescriptor | null {
  const { target, workspaceId, repo, cwd } = input
  const concreteWorkspace = input.concreteWorkspace || workspaceId === FLOATING_TERMINAL_WORKTREE_ID
  if (!target || (!concreteWorkspace && !repo)) {
    return null
  }
  return terminalModelDiscoveryDescriptor(
    state,
    {
      target,
      worktreeId: concreteWorkspace ? (workspaceId ?? null) : null,
      worktreePath: ''
    },
    {
      ...(concreteWorkspace && workspaceId ? { worktree: `id:${workspaceId}` } : {}),
      ...(!concreteWorkspace && repo
        ? { repo: repo.id, repoHostId: getRepoExecutionHostId(repo) }
        : {}),
      ...(cwd ? { cwd } : {})
    }
  )
}

export function agentPickerCliDiscoveryRuntime(
  state: Parameters<typeof resolveWorktreeModelDiscoveryRuntime>[0],
  worktreeId: string | null,
  target: RuntimeClientTarget | null,
  repoPath?: string
): RuntimeGitContext | null {
  const owner =
    worktreeId || target?.kind === 'local'
      ? resolveWorktreeModelDiscoveryRuntime(state, worktreeId)
      : null
  return !owner || owner.connectionId
    ? null
    : worktreeId
      ? owner
      : { ...owner, worktreePath: repoPath ?? '' }
}

export function agentPickerCatalogSettingsKey(
  defaults: AgentPickerDefaultSettings | null | undefined
) {
  return [
    defaults && {
      agentDefaultArgs: defaults.agentDefaultArgs,
      agentLaunchChoices: defaults.agentLaunchChoices,
      agentPermissionDefault: defaults.agentPermissionDefault,
      agentPermissionOverrides: defaults.agentPermissionOverrides,
      nativeChatSessionOptions: defaults.nativeChatSessionOptions,
      nativeChatPermissionMode: defaults.nativeChatPermissionMode
    }
  ]
}

export function useAgentPickerTerminalDiscoveryKey(
  executionHostId: string | null,
  { worktreeId: workspaceId, repoId }: { worktreeId?: string; repoId?: string },
  cwd?: string | null
) {
  const selector = useMemo(
    () =>
      executionHostId
        ? createTerminalModelDiscoveryKeySelector((state) =>
            agentPickerTerminalDiscovery(state, {
              target: structuredAgentSessionTargetForHost(executionHostId),
              concreteWorkspace: Boolean(workspaceId),
              workspaceId,
              repo: repoId
                ? state.repos.find(
                    (repo) => repo.id === repoId && getRepoExecutionHostId(repo) === executionHostId
                  )
                : undefined,
              cwd
            })
          )
        : () => undefined,
    [executionHostId, workspaceId, repoId, cwd]
  )
  return useAppStateValue(selector)
}
