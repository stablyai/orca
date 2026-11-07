import type { AppState } from '@/store/types'
import { workspaceTabs } from '@/lib/structured-chat-tab-index'
import { selectExecutionHostDisplayLabel } from '@/lib/execution-host-display-label'
import { findIndexedRepoOwnerForHost } from '@/lib/workspace/ownership/repo-owner-index'
import { getWslDistroFromPath } from '@/lib/local-preflight-context'
import { selectWslHostDistro } from '@/components/wsl-host-mark/WslHostMark'
import { resolvePaneWslDistro } from '@/components/terminal-pane/host-state/terminal-pane-wsl-distro'
import type { Repo } from '../../../../shared/repo-types'
import { getHostSettingOverride } from '../../../../shared/host-setting-overrides'
import { isFolderRepo } from '../../../../shared/repo-kind'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { getKnownExecutionHostIdForWorktree } from '@/lib/workspace/ownership/worktree-runtime-owner'
import { findKnownWorktreeById } from '@/store/slices/worktrees/listing/detected-worktree-meta'
import {
  selectWorktreesByRepo,
  selectFolderWorkspaces,
  selectDetectedWorktreesByRepo
} from '@/store/workspace-record-selectors'
import {
  isUnresolvedOwnerHostId,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import {
  floatingWorkspaceToWorktree,
  isFloatingWorkspaceId
} from '../../../../shared/floating-workspace-worktree'
import {
  createNativeChatTabOwnerSelector,
  FILE_LINK_CONTEXT_INPUT_KEYS
} from './native-chat-file-link'
import { resolveNativeChatTabDirectory } from './native-chat-tab-directory'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'

const OWNER_CONTEXT_INPUT_KEYS = FILE_LINK_CONTEXT_INPUT_KEYS.filter(
  (key) =>
    key !== 'settings' &&
    key !== 'runtimeEnvironments' &&
    key !== 'activeWorktreeId' &&
    key !== 'activeWorkspaceExecutionHostId'
)

export type NativeChatComposerWorkspaceTarget = Pick<
  NativeChatStructuredComposerTransport,
  'worktreeId' | 'runtimeEnvironmentId'
>

export function createNativeChatComposerWorkspaceSelector(
  tabId: string,
  target?: NativeChatComposerWorkspaceTarget
) {
  const selectOwner = createNativeChatTabOwnerSelector(tabId)
  let unifiedBucket: ReturnType<typeof workspaceTabs>
  let tabHost: ExecutionHostId | undefined
  let inputs: unknown[] | undefined
  let context: ComposerWorkspaceContext = {}
  let runtimeSource: AppState['runtimeEnvironments']
  let runtimeIds: string[] = []
  const selectMachine = createComposerMachineSelector(!target)
  let presentation: {
    hostId?: ExecutionHostId
    machine?: string
    checkout?: string
    kind?: 'folder' | 'main' | 'worktree'
    path?: string
    branch?: string
    head?: string
  } = {}
  return (state: AppState) => {
    const worktreeId = target?.worktreeId ?? selectOwner(state)
    const unified = worktreeId ? workspaceTabs(state.unifiedTabsByWorktree, worktreeId) : undefined
    if (unifiedBucket !== unified) {
      tabHost = unified?.find((tab) => tab.id === tabId)?.executionHostId
      unifiedBucket = unified
    }
    // A structured transport's null environment positively identifies this host.
    const explicitHost = target
      ? target.runtimeEnvironmentId
        ? toRuntimeExecutionHostId(target.runtimeEnvironmentId)
        : 'local'
      : tabHost
    const catalog = {
      repos: state.repos,
      projectGroups: state.projectGroups,
      worktreesByRepo: selectWorktreesByRepo(state),
      folderWorkspaces: selectFolderWorkspaces(state),
      detectedWorktreesByRepo: selectDetectedWorktreesByRepo(state),
      floatingWorkspacePath: state.floatingWorkspacePath
    }
    if (!explicitHost && runtimeSource !== state.runtimeEnvironments) {
      runtimeSource = state.runtimeEnvironments
      const ids = runtimeSource.map((entry) => entry.id)
      if (ids.length !== runtimeIds.length || ids.some((id, index) => id !== runtimeIds[index])) {
        runtimeIds = ids
      }
    }
    const next = [
      worktreeId,
      explicitHost,
      unified,
      state.structuredSessionLaunchDirectoryByTabId[tabId],
      ...Object.values(catalog),
      // Names and connection status cannot change a chat's catalog address.
      ...(explicitHost
        ? []
        : [
            state.activeWorktreeId === worktreeId ? state.activeWorkspaceExecutionHostId : null,
            runtimeIds,
            ...OWNER_CONTEXT_INPUT_KEYS.map((key) => state[key])
          ])
    ]
    if (!inputs || next.some((input, index) => input !== inputs?.[index])) {
      inputs = next
      const host = explicitHost ?? getKnownExecutionHostIdForWorktree(state, worktreeId)
      const path = worktreeId ? resolveNativeChatTabDirectory(state, tabId, worktreeId, host) : null
      const row =
        path && worktreeId
          ? isFloatingWorkspaceId(worktreeId)
            ? floatingWorkspaceToWorktree(path)
            : findKnownWorktreeById(catalog, worktreeId, host ?? undefined)
          : undefined
      const repo = row
        ? findIndexedRepoOwnerForHost(state.repos, row.repoId, host ?? 'local')
        : undefined
      context = {
        host: host && !isUnresolvedOwnerHostId(host) ? host : undefined,
        row,
        repo,
        path: path ?? undefined
      }
      presentation = {
        checkout: row?.displayName,
        kind: row
          ? (repo && isFolderRepo(repo)) ||
            parseWorkspaceKey(row.id)?.type === 'folder' ||
            isFloatingWorkspaceId(row.id)
            ? 'folder'
            : row.isMainWorktree
              ? 'main'
              : 'worktree'
          : undefined,
        path: path ?? undefined,
        branch: row?.branch,
        head: row?.head
      }
    }
    const machine = selectMachine(state, context)
    if (presentation.hostId !== context.host || presentation.machine !== machine) {
      presentation = { ...presentation, hostId: context.host, machine }
    }
    return presentation
  }
}

type ComposerWorkspaceContext = {
  host?: ExecutionHostId
  row?: ReturnType<typeof findKnownWorktreeById>
  repo?: Repo | null
  path?: string
}

function createComposerMachineSelector(terminalBacked: boolean) {
  let runtimeSource: AppState['runtimeEnvironments']
  let environmentHost: ExecutionHostId | undefined
  let environment: AppState['runtimeEnvironments'][number] | undefined
  let machineInputs: unknown[] | undefined
  let machine: string | undefined
  return (state: AppState, context: ComposerWorkspaceContext): string | undefined => {
    const { host, row, repo, path } = context
    const parsed = host ? parseExecutionHostId(host) : null
    if (runtimeSource !== state.runtimeEnvironments || environmentHost !== host) {
      runtimeSource = state.runtimeEnvironments
      environmentHost = host
      environment =
        parsed?.kind === 'runtime'
          ? runtimeSource.find((entry) => entry.id === parsed.environmentId)
          : undefined
    }
    const override = host ? getHostSettingOverride(state.settings, host, 'displayLabel') : undefined
    const label =
      host && parsed?.kind === 'ssh'
        ? selectExecutionHostDisplayLabel(state, host, {
            sshEnvironmentId: row?.runtimeOwnerEnvironmentId
          })
        : undefined
    const localRuntime = host === 'local' && terminalBacked
    const nextMachine = [
      context,
      override,
      label,
      environment,
      host === 'local' ? state.settings?.machineName : undefined,
      ...(localRuntime
        ? [
            state.projects,
            state.settings?.localWindowsRuntimeDefault,
            state.settings?.localAgentRuntime,
            state.settings?.localAgentWslDistro,
            state.settings?.terminalWindowsShell,
            state.settings?.terminalWindowsWslDistro
          ]
        : [])
    ]
    if (!machineInputs || nextMachine.some((input, index) => input !== machineInputs?.[index])) {
      machineInputs = nextMachine
      const distro =
        host && parsed?.kind === 'runtime'
          ? selectWslHostDistro({ runtimeEnvironments: environment ? [environment] : [] }, host)
          : localRuntime
            ? row && repo && path && !isFloatingWorkspaceId(row.id)
              ? resolvePaneWslDistro(state, row.id, path, { worktree: row, repo })
              : getWslDistroFromPath(path)
            : null
      machine =
        distro ??
        override ??
        (host === 'local'
          ? state.settings?.machineName
          : (label ??
            (host
              ? selectExecutionHostDisplayLabel(
                  { ...state, runtimeEnvironments: environment ? [environment] : [] },
                  host
                )
              : undefined)))
    }
    return machine
  }
}
