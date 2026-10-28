import { hostWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'
import { refreshWebRuntimeSessionTabsSnapshot } from '@/runtime/web-runtime-session-snapshot'
import { toWebTerminalSurfaceTabId } from '../../../../shared/terminal-surface-id'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { parseExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import type { RuntimeMobileSessionCreateTerminalResult } from '../../../../shared/runtime-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { isValidHostTerminalTabId } from '../../../../shared/terminal-tab-id'
import { isTerminalLeafId } from '../../../../shared/stable-pane-id'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { getComposerEligibleRepos } from '@/lib/new-workspace-composer-repo'
import { resolveWorkspaceCreationTarget } from '@/lib/project-host-workspace-target'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import { getProjectHostSetupProjectionFromState } from '@/store/project-host-setup-selector'
import { selectKnownWorktreeById } from '@/store/selectors'
import {
  getFolderWorkspaceWorktree,
  selectFolderWorkspaces,
  selectWorktreesByRepo,
  selectWorkspaceByHostTarget
} from '@/store/workspace-record-selectors'
import { useAppStore } from '../../store'
import { getWorktreeProjectId, isLocalHostTerminalSource } from './tab-bar-host-terminal-targets'

export async function createTerminalTabOnHost({
  worktreeId,
  executionHostId,
  projectHostSetupId,
  agent,
  groupId
}: {
  worktreeId: string
  executionHostId: ExecutionHostId
  projectHostSetupId: string
  agent?: TuiAgent
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
  const resolved = resolveWorkspaceCreationTarget({
    eligibleRepos: getComposerEligibleRepos(state.repos),
    projects: projection.projects,
    projectHostSetups: projection.setups,
    projectId,
    hostId: executionHostId,
    projectHostSetupId,
    projectHostSetupHostId: executionHostId
  })
  if (resolved.status !== 'ready') {
    throw new Error(resolved.reason)
  }
  const { setup } = resolved.target
  if (!projectId || setup.projectId !== projectId) {
    throw new Error('project_not_set_up_on_host')
  }
  const candidates = [
    ...Object.values(selectWorktreesByRepo(state)).flat(),
    ...selectFolderWorkspaces(state).map((row) => getFolderWorkspaceWorktree(row))
  ].filter(
    (row) =>
      row.path === setup.path &&
      selectWorkspaceByHostTarget(
        state,
        hostWorktreeTarget({ id: row.id, hostId: executionHostId })
      ) === row
  )
  if (candidates.length !== 1) {
    throw new Error(candidates.length ? 'selector_ambiguous' : 'selector_not_found')
  }
  const hostWorktreeId = candidates[0]!.id
  const created = await callRuntimeRpc<RuntimeMobileSessionCreateTerminalResult>(
    { kind: 'environment', environmentId: host.environmentId },
    'session.tabs.createTerminal',
    {
      worktree: toRuntimeWorktreeSelector(hostWorktreeId),
      activate: false,
      select: true,
      navigation: 'caller',
      clientMutationId: createBrowserUuid(),
      ...(agent ? { agent } : {})
    },
    { timeoutMs: 15_000 }
  )
  const tab = created.tab
  if (!isValidHostTerminalTabId(tab.parentTabId) || !isTerminalLeafId(tab.leafId)) {
    throw new Error('invalid_host_reply')
  }
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
}
