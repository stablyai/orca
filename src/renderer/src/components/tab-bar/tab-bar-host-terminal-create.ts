import { refreshWebRuntimeSessionTabsSnapshot } from '@/runtime/web-runtime-session-snapshot'
import { toWebTerminalSurfaceTabId } from '../../../../shared/terminal-surface-id'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { parseExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import type {
  RuntimeMobileSessionCreateTerminalResult,
  RuntimeWorktreePsResult
} from '../../../../shared/runtime-types'
import type { ProjectHostSetup } from '../../../../shared/project-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import {
  folderWorkspaceToWorktree,
  getFolderWorkspaceWorktreeHostId
} from '../../../../shared/folder-workspace-worktree'
import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'
import { isValidHostTerminalTabId } from '../../../../shared/terminal-tab-id'
import { isTerminalLeafId } from '../../../../shared/stable-pane-id'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import { getProjectHostSetupProjectionFromState } from '@/store/project-host-setup-selector'
import { selectKnownWorktreeById } from '@/store/selectors'
import { useAppStore } from '../../store'
import { getWorktreeProjectId, isLocalHostTerminalSource } from './tab-bar-host-terminal-targets'

export async function createTerminalTabOnHost({
  worktreeId,
  executionHostId,
  projectHostSetupId,
  groupId
}: {
  worktreeId: string
  executionHostId: ExecutionHostId
  projectHostSetupId: string
  groupId?: string
}) {
  const state = useAppStore.getState()
  const source = selectKnownWorktreeById(state, worktreeId)
  const host = parseExecutionHostId(executionHostId)
  if (!source || !isLocalHostTerminalSource(state, worktreeId)) {
    throw new Error('source_worktree_not_local')
  }
  if (host?.kind !== 'runtime') {
    throw new Error('runtime_host_required')
  }
  const projection = getProjectHostSetupProjectionFromState(state)
  const sourceRepo = state.repos.find((repo) => repo.id === source.repoId)
  const projectId = getWorktreeProjectId(source, sourceRepo, projection.setups)
  const target = { kind: 'environment' as const, environmentId: host.environmentId }
  const { setups } = await callRuntimeRpc<{ setups: ProjectHostSetup[] }>(
    target,
    'projectHostSetup.list',
    {}
  )
  const candidates = setups.filter(
    (setup) =>
      setup.id === projectHostSetupId &&
      setup.projectId === projectId &&
      (setup.hostId === 'local' || setup.hostId === host.id)
  )
  if (candidates.length !== 1) {
    throw new Error(candidates.length ? 'selector_ambiguous' : 'setup-not-found')
  }
  const setup = candidates[0]!
  if (setup.setupState !== 'ready') {
    throw new Error('setup-not-ready')
  }
  const [catalog, { folderWorkspaces }] = await Promise.all([
    callRuntimeRpc<RuntimeWorktreePsResult>(target, 'worktree.ps', {
      limit: Number.MAX_SAFE_INTEGER
    }),
    callRuntimeRpc<{ folderWorkspaces: FolderWorkspace[] }>(target, 'folderWorkspace.list', {})
  ])
  const active = catalog.worktrees.find(
    (row) =>
      row.isActive &&
      row.repoId === setup.repoId &&
      (row.hostId === undefined || row.hostId === setup.hostId)
  )
  const folders = folderWorkspaces.filter(
    (row) =>
      getFolderWorkspaceWorktreeHostId(row) === setup.hostId &&
      normalizeRuntimePathForComparison(row.folderPath) ===
        normalizeRuntimePathForComparison(setup.path)
  )
  if (!active && folders.length > 1) {
    throw new Error('selector_ambiguous')
  }
  const selector = active
    ? toRuntimeWorktreeSelector(active.worktreeId)
    : folders[0]
      ? toRuntimeWorktreeSelector(folderWorkspaceToWorktree(folders[0]).id)
      : `path:${setup.path}`
  const { worktree } = await callRuntimeRpc<{ worktree: Pick<Worktree, 'id'> }>(
    target,
    'worktree.show',
    { worktree: selector }
  )
  const hostWorktreeId = worktree.id
  const created = await callRuntimeRpc<RuntimeMobileSessionCreateTerminalResult>(
    target,
    'session.tabs.createTerminal',
    {
      worktree: toRuntimeWorktreeSelector(hostWorktreeId),
      activate: true,
      select: true,
      navigation: 'caller',
      clientMutationId: createBrowserUuid()
    },
    { timeoutMs: 15_000 }
  )
  const tab = created.tab
  try {
    if (!isValidHostTerminalTabId(tab.parentTabId) || !isTerminalLeafId(tab.leafId)) {
      throw new Error('invalid_host_reply')
    }
    await callRuntimeRpc(target, 'session.tabs.activate', {
      worktree: toRuntimeWorktreeSelector(hostWorktreeId),
      tabId: tab.parentTabId,
      leafId: tab.leafId,
      navigation: 'host'
    })
    const latest = useAppStore.getState()
    if (!isLocalHostTerminalSource(latest, worktreeId)) {
      throw new Error('source_worktree_not_local')
    }
    const localTabId = toWebTerminalSurfaceTabId(tab.parentTabId)
    if (!latest.tabsByWorktree[worktreeId]?.some((row) => row.id === localTabId)) {
      latest.createTab(worktreeId, groupId, undefined, {
        id: localTabId,
        initialLeafId: tab.leafId,
        mirroredHostTab: true,
        hostTerminalAlias: {
          executionHostId: host.id,
          worktreeId: hostWorktreeId,
          tabId: tab.parentTabId,
          leafId: tab.leafId
        }
      })
    }
    latest.setActiveTab(localTabId)
    latest.setActiveTabType('terminal', worktreeId)
    focusTerminalTabSurface(localTabId)
    await refreshWebRuntimeSessionTabsSnapshot(host.environmentId, hostWorktreeId, {
      afterCurrentInFlight: true,
      acceptCurrentSnapshot: true
    })
    return {
      executionHostId: host.id,
      hostWorktreeId,
      tabId: tab.parentTabId,
      leafId: tab.leafId,
      handle: tab.terminal,
      title: tab.title
    }
  } catch (error) {
    try {
      await callRuntimeRpc(target, 'session.tabs.close', {
        worktree: toRuntimeWorktreeSelector(hostWorktreeId),
        tabId: tab.parentTabId
      })
    } catch {
      // Preserve the creation failure if host cleanup also fails.
    }
    throw error
  }
}
