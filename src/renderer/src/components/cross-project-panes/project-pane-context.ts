import type { AppState } from '@/store'
import type { WorkspacePane, WorkspaceView } from '../../../../shared/window-pane-types'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import {
  findIndexedRepoOwnerForHost,
  findIndexedFolderWorkspaceOwner,
  findIndexedProjectGroupOwner
} from '@/lib/worktree-runtime-owner-index'
import { isLocalWorkspaceWindowEnvironment } from '@/lib/workspace-window-runtime-scope'
import { resolveWorkspaceView } from '@/store/slices/window-pane-selection'
import { resolveRepoProject } from '@/lib/project-presentation-identity'

export function projectPaneContext(
  state: AppState,
  owner?: WorkspacePane['workspace'] | WorkspaceView
) {
  const host = parseExecutionHostId(owner?.executionHostId)
  const scope = parseWorkspaceKey(owner?.worktreeId ?? '')
  const folderOwner =
    scope?.type === 'folder'
      ? findIndexedFolderWorkspaceOwner(state.folderWorkspaces, scope.folderWorkspaceId, host?.id)
      : null
  const folder = state.folderWorkspaces.find((entry) => entry === folderOwner)
  const groupOwner =
    folder && findIndexedProjectGroupOwner(state.projectGroups, folder.projectGroupId, host?.id)
  const group = state.projectGroups.find((entry) => entry === groupOwner)
  const worktree =
    owner && !folder ? state.getKnownWorktreeById(owner.worktreeId, owner.executionHostId) : null
  const repo =
    worktree && host ? findIndexedRepoOwnerForHost(state.repos, worktree.repoId, host.id) : null
  const project = resolveRepoProject(state, repo)
  const projectName =
    project?.displayName ?? repo?.displayName ?? group?.name ?? owner?.worktreeId ?? 'No workspace'
  const workspace = folder?.name ?? worktree?.displayName ?? owner?.worktreeId ?? ''
  const path = folder?.folderPath ?? worktree?.path ?? repo?.path ?? ''
  const view = owner && 'tabId' in owner ? owner : undefined
  const tab = view && resolveWorkspaceView(state, view)
  const session =
    tab?.customLabel ?? tab?.label ?? view?.label ?? (view ? 'Unavailable session' : 'No session')
  const connectionId =
    host?.kind === 'ssh' ? host.targetId : (folder?.connectionId ?? repo?.connectionId)
  const sshLabel =
    connectionId &&
    (state.sshTargetLabels.get(connectionId) ?? state.removedSshTargetLabels.get(connectionId))
  const environment =
    host?.kind === 'runtime'
      ? state.runtimeEnvironments.find((entry) => entry.id === host.environmentId)
      : null
  const localRuntime =
    host?.kind === 'runtime' &&
    (isLocalWorkspaceWindowEnvironment(host.environmentId) ||
      (!!environment?.runtimeId &&
        environment.runtimeId === window.orcaWorkspaceWindowNative?.localRuntimeId))
  const hostName = connectionId
    ? `SSH · ${sshLabel || connectionId}`
    : host?.kind === 'local' || localRuntime
      ? 'This computer'
      : host?.kind === 'runtime'
        ? `Remote · ${environment?.name ?? host.environmentId}`
        : 'Unknown host'
  const unavailable = !!view && !tab
  const disconnected =
    (connectionId && state.sshConnectionStates.get(connectionId)?.status !== 'connected') ||
    (host?.kind === 'runtime' &&
      !state.runtimeStatusByEnvironmentId.get(host.environmentId)?.status)
  const availability = unavailable ? 'Unavailable' : disconnected ? 'Connection unverifiable' : ''
  return {
    projectName,
    accentColor: repo?.badgeColor ?? group?.color ?? undefined,
    workspace,
    session,
    hostName,
    path,
    availability,
    projectKey: JSON.stringify([
      host?.id,
      project?.id ?? repo?.id ?? group?.id ?? owner?.worktreeId
    ]),
    repoIcon: project?.repoIcon ?? repo?.repoIcon,
    label: [projectName, workspace, session, hostName, path, availability]
      .filter(Boolean)
      .join(' · ')
  }
}
