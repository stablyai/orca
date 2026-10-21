import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type {
  OpenFile,
  BranchCompareLike,
  EditorOpenTargetOptions
} from '@/store/slices/editor/types/open-file'
import type { OpenFileOptions } from '@/store/slices/editor/types/editor-files-slice'
import type { GitStatusEntry } from '../../../shared/git-status-types'
import type { GitBranchChangeEntry } from '../../../shared/git-diff-compare-types'
import { isHtmlFilePath } from '../../../shared/html-file-url'
import { detectLanguage } from './language-detect'
import { joinPath } from './path'
import { getWorkspaceFilePreviewPlan, openFileInBrowserTab } from './file-preview'
import { openUncommittedEntry } from './workspace-file-changes-open'
import { resolveWorkspaceDocAddressTarget } from './workspace-doc-address-input'
import { selectWorkspaceSurface } from './workspace-surface-reveal'
import { openLinkedFileInEditor } from './editor-file-link-open'
import type { EditorOpenLinkIntent } from '@/store/slices/editor/types/editor-open-link-intent'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { activateAndRevealWorkspace } from './worktree-activation'
import { runtimeEnvironmentIdUnlessTwin } from './resolve-owner'
import { FILE_DOC_PREVIEW_RUNTIME_CAPABILITY } from '../../../shared/files-runtime-capabilities'

type ChangeOpenRequest = {
  worktreeId: string
  worktreePath: string
  intent?: 'default' | 'diff'
  options?: EditorOpenTargetOptions
} & (
  | { kind: 'uncommitted'; entry: GitStatusEntry }
  | { kind: 'branch'; entry: GitBranchChangeEntry; compare: BranchCompareLike }
)

export type WorkspaceFileOpenRequest =
  | {
      kind: 'file'
      file: Omit<OpenFile, 'id' | 'isDirty'>
      intent?: 'default' | 'source'
      options?: OpenFileOptions
    }
  | { kind: 'preview'; filePath: string; worktreeId: string; targetGroupId?: string }
  | {
      kind: 'link'
      file: Omit<OpenFile, 'id' | 'isDirty' | 'language' | 'mode'>
      intent?: 'default' | 'source'
      linkIntent: EditorOpenLinkIntent | null
      position: { line: number | null; column: number | null }
      isCurrentRequest: () => boolean
      executionHostId: ExecutionHostId
      clientLocal: boolean
    }
  | ChangeOpenRequest

export type WorkspaceFileOpenResult =
  | { surface: 'preview' }
  | { surface: 'editor'; fileId: string }
  | { surface: 'diff' }
  | { surface: 'refused' }

export type WorkspaceFileOpener = typeof openWorkspaceFile

function hasWorkingTreeFile(
  entry: Pick<GitStatusEntry, 'status' | 'conflictStatus' | 'submodule'>
): boolean {
  return entry.status !== 'deleted' && !entry.conflictStatus && !entry.submodule
}

function hasCurrentWorkingTreeFile(path: string, changes: GitStatusEntry[]): boolean {
  const workingTreeChange = changes.find(
    (change) => change.path === path && change.area !== 'staged'
  )
  if (workingTreeChange) {
    return hasWorkingTreeFile(workingTreeChange)
  }
  return !changes.some(
    (change) =>
      (change.path === path && !hasWorkingTreeFile(change)) ||
      (change.status === 'renamed' && change.oldPath === path)
  )
}

function openRequestedPreview(
  request: Extract<WorkspaceFileOpenRequest, { kind: 'preview' }>
): WorkspaceFileOpenResult {
  const state = useAppStore.getState()
  const target = resolveWorkspaceDocAddressTarget(state, request.worktreeId, request.filePath)
  if (target.status === 'unsupported') {
    throw new Error(target.message)
  }
  const worktreeId =
    target.status === 'workspace-doc' ? target.docLocation.worktreeId : request.worktreeId
  if (state.activeWorktreeId !== worktreeId) {
    selectWorkspaceSurface(state, worktreeId)
  }
  const plan = openFileInBrowserTab({
    filePath: request.filePath,
    worktreeId,
    ...(worktreeId === request.worktreeId ? { targetGroupId: request.targetGroupId } : {})
  })
  if (plan.status === 'unsupported') {
    throw new Error(plan.message)
  }
  return { surface: 'preview' }
}

function defaultPreviewTarget(
  request: Exclude<WorkspaceFileOpenRequest, { kind: 'preview' }>,
  state: Pick<AppState, 'gitStatusByWorktree'>
): Parameters<typeof openFileInBrowserTab>[0] | null {
  if (request.intent === 'source' || request.intent === 'diff') {
    return null
  }
  const filePath =
    'file' in request ? request.file.filePath : joinPath(request.worktreePath, request.entry.path)
  if (!isHtmlFilePath(filePath)) {
    return null
  }
  switch (request.kind) {
    case 'file':
      return request.file.mode === 'edit' &&
        !request.file.terminalArtifactGrantId &&
        !request.file.externalSshTargetId
        ? {
            filePath,
            worktreeId: request.file.worktreeId,
            targetGroupId: request.options?.targetGroupId
          }
        : null
    case 'link':
      return request.position.line === null &&
        !request.file.terminalArtifactGrantId &&
        !request.file.externalSshTargetId &&
        !request.linkIntent?.targetGroupId
        ? {
            filePath,
            worktreeId: request.file.worktreeId,
            ...(request.clientLocal ? { clientLocal: true } : {})
          }
        : null
    case 'uncommitted':
    case 'branch':
      if (
        !hasWorkingTreeFile(request.entry) ||
        !hasCurrentWorkingTreeFile(
          request.entry.path,
          state.gitStatusByWorktree[request.worktreeId] ?? []
        )
      ) {
        return null
      }
      return {
        filePath,
        worktreeId: request.worktreeId,
        targetGroupId: request.options?.targetGroupId
      }
  }
}

export function openWorkspaceFile(request: WorkspaceFileOpenRequest): WorkspaceFileOpenResult {
  if (request.kind === 'preview') {
    return openRequestedPreview(request)
  }
  const state = useAppStore.getState()
  const target = defaultPreviewTarget(request, state)
  if (target) {
    const plan = getWorkspaceFilePreviewPlan(
      state,
      target.worktreeId,
      target.filePath,
      target.clientLocal
    )
    const previewEnvironmentId =
      plan.status === 'doc-preview'
        ? runtimeEnvironmentIdUnlessTwin(state, target.worktreeId)
        : null
    if (
      plan.status !== 'unsupported' &&
      (!previewEnvironmentId ||
        state.runtimeStatusByEnvironmentId
          ?.get(previewEnvironmentId)
          ?.status?.capabilities?.includes(FILE_DOC_PREVIEW_RUNTIME_CAPABILITY) === true)
    ) {
      if (request.kind === 'link') {
        activateAndRevealWorkspace(target.worktreeId, {
          providesInitialSurface: true,
          executionHostId: request.executionHostId
        })
      }
      if (openFileInBrowserTab(target).status !== 'unsupported') {
        return { surface: 'preview' }
      }
    }
  }
  if (request.kind === 'link') {
    const worktreeId = request.file.worktreeId
    if (worktreeId) {
      activateAndRevealWorkspace(worktreeId, {
        providesInitialSurface: true,
        executionHostId: request.executionHostId
      })
    }
    const opened = openLinkedFileInEditor(
      request.file,
      request.linkIntent,
      request.position,
      request.isCurrentRequest
    )
    return opened ? { surface: 'editor', fileId: opened.fileId } : { surface: 'refused' }
  }
  if (request.kind === 'file') {
    return { surface: 'editor', fileId: state.openFile(request.file, request.options) }
  }
  if (request.kind === 'uncommitted') {
    openUncommittedEntry(
      state,
      request.worktreeId,
      request.worktreePath,
      request.entry,
      request.options
    )
  } else {
    state.openBranchDiff(
      request.worktreeId,
      request.worktreePath,
      request.entry,
      request.compare,
      detectLanguage(request.entry.path),
      request.options
    )
  }
  return { surface: 'diff' }
}
