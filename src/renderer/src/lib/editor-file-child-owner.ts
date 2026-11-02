import type { AppState } from '@/store/types'
import type { Repo } from '../../../shared/repo-types'
import type { HostAuthority } from '../../../shared/host-authority'
import {
  getRepoExecutionHostId,
  getRepoSshConnectionId,
  parseExecutionHostId
} from '../../../shared/execution-host'
import { getFolderFileConnectionOwnerFromState } from './connection-owner-resolution'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import {
  assertEditorFileOperationCurrent,
  getExpectedSshConnectionGeneration,
  OWNER_CHANGED_MESSAGE,
  type EditorFileOperationProvenance
} from './editor-file-operation-provenance'
import {
  assertWorktreeOperationGenerationSnapshotCurrent,
  captureWorktreeOperationGenerationSnapshot
} from './worktree-operation-generation'
import type { WorktreeOperationRoute } from './worktree-operation-route'
import { resolveContinuedRuntimeEnvironmentRevision } from '@/runtime/runtime-environment-revision'

/** A tab retains its owner; a new operation uses that paired host's current session. */
export function captureEditorFileOperationForOwner(
  state: AppState,
  file: { worktreeId: string; filePath?: string },
  provenance: EditorFileOperationProvenance
): EditorFileOperationProvenance {
  const previous = provenance.generation
  const current = captureWorktreeOperationGenerationSnapshot(previous.route, previous.authority)
  const environmentId = previous.route.runtimeEnvironmentId
  const captured = {
    ...provenance,
    generation: {
      ...previous,
      runtimeConnectionGeneration: current.runtimeConnectionGeneration,
      runtimeSshGeneration: current.runtimeSshGeneration,
      runtimePairingRevision:
        environmentId && previous.runtimePairingRevision !== undefined
          ? resolveContinuedRuntimeEnvironmentRevision(
              environmentId,
              previous.runtimePairingRevision
            )
          : previous.runtimePairingRevision
    }
  }
  if (file.filePath !== undefined) {
    assertEditorFileOwnerCurrent(state, { ...file, filePath: file.filePath }, captured)
  } else {
    assertEditorFileOperationCurrent(state, file.worktreeId, captured)
  }
  return captured
}

export function editorFileChildRoute(repo: Repo | undefined): WorktreeOperationRoute | null {
  if (!repo) {
    return null
  }
  const executionHostId = getRepoExecutionHostId(repo)
  const host = parseExecutionHostId(executionHostId)
  return {
    executionHostId,
    runtimeEnvironmentId: host?.kind === 'runtime' ? host.environmentId : null
  }
}

export function editorFileChildAuthority(repo: Repo | undefined): HostAuthority | undefined {
  const route = editorFileChildRoute(repo)
  if (!route || !repo) {
    return undefined
  }
  const ssh = getRepoSshConnectionId(repo)
  return {
    endpoint: route.runtimeEnvironmentId
      ? { kind: 'environment', environmentId: route.runtimeEnvironmentId }
      : { kind: 'self' },
    at: ssh ? `ssh:${encodeURIComponent(ssh)}` : 'local'
  }
}

/** Validate the captured resource owner without substituting a new child on the same host. */
export function assertEditorFileOwnerCurrent(
  state: AppState,
  file: { worktreeId: string; filePath: string },
  provenance: EditorFileOperationProvenance
): WorktreeOperationRoute {
  if (!provenance.childRepo) {
    return assertEditorFileOperationCurrent(state, file.worktreeId, provenance)
  }
  const scope = parseWorkspaceKey(file.worktreeId)
  const child =
    scope?.type === 'folder'
      ? getFolderFileConnectionOwnerFromState(state, scope.folderWorkspaceId, file.filePath)?.repo
      : undefined
  if (!child || child.id !== provenance.childRepo.id || child.path !== provenance.childRepo.path) {
    throw new Error(OWNER_CHANGED_MESSAGE)
  }
  const route = assertWorktreeOperationGenerationSnapshotCurrent(
    () => state,
    file.worktreeId,
    provenance.generation,
    () => new Error(OWNER_CHANGED_MESSAGE),
    () => editorFileChildRoute(child),
    () => editorFileChildAuthority(child)
  )
  if (
    getExpectedSshConnectionGeneration(state, route, provenance.generation.authority) !==
    provenance.expectedSshConnectionGeneration
  ) {
    throw new Error(OWNER_CHANGED_MESSAGE)
  }
  return route
}
