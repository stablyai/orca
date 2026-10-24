import type { OpenFile } from '@/store/slices/editor'
import type { AppState } from '@/store/types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { isFloatingWorkspaceId } from '../../../shared/floating-workspace-worktree'
import { findWorkspaceFileRoute } from './runtime-workspace-file-route'
import { editorBufferRouteEpochOf } from '@/store/slices/editor/buffers/editor-buffer-identity-cache'

type OwnerScopedFile = Pick<
  OpenFile,
  | 'worktreeId'
  | 'filePath'
  | 'relativePath'
  | 'readOnly'
  | 'liveTail'
  | 'runtimeEnvironmentId'
  | 'terminalArtifactGrantId'
  | 'externalSshTargetId'
>

type OwnerScope = { worktreeId: string; relativePath: string }
const ownerScopeCache = new WeakMap<object, { epoch: object; scope: OwnerScope }>()

/**
 * The workspace whose watch covers an open file. A read-only view of a file another workspace on
 * this computer holds (#32158) lives in one workspace but is watched with the one that holds the
 * file, derived from the catalog so a restored view needs nothing stored.
 */
export function openFileOwnerScope(file: OwnerScopedFile, state: AppState): OwnerScope {
  const own = { worktreeId: file.worktreeId, relativePath: file.relativePath }
  // Why: only a read-only absolute view may sit outside the workspace holding its file; a live-tail
  // log follows itself and must not pull in a recursive watch of a folder that holds it.
  if (
    file.readOnly !== true ||
    file.liveTail === true ||
    file.relativePath !== file.filePath ||
    file.terminalArtifactGrantId ||
    // Why: only this computer's files are viewed outside their workspace; an SSH or server
    // tab naming another workspace's path is moved there by the loader instead.
    file.externalSshTargetId ||
    file.runtimeEnvironmentId?.trim() ||
    isFloatingWorkspaceId(file.worktreeId)
  ) {
    return own
  }
  // Why cached: watch selectors run on every store update; the catalog walk only on route changes.
  const epoch = editorBufferRouteEpochOf(state)
  const cached = ownerScopeCache.get(file)
  if (cached?.epoch === epoch) {
    return cached.scope
  }
  const route = findWorkspaceFileRoute(state, LOCAL_EXECUTION_HOST_ID, file.filePath)
  const scope = route ? { worktreeId: route.worktreeId, relativePath: route.relativePath } : own
  ownerScopeCache.set(file, { epoch, scope })
  return scope
}

/** The workspace an open file is scoped to; without a catalog, the one it lives in. */
export function openFileOwnerWorktreeId(
  file: OwnerScopedFile,
  state: AppState | undefined
): string {
  return state ? openFileOwnerScope(file, state).worktreeId : file.worktreeId
}
