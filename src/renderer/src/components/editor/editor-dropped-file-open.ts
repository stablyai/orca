import { toast } from 'sonner'
import { detectLanguage } from '@/lib/language-detect'
import { isPathInsideWorktree, toWorktreeRelativePath } from '@/lib/terminal-links'
import { useAppStore } from '@/store'
import { getConnectionId } from '@/lib/connection-context'
import { joinPath } from '@/lib/path'
import {
  getRuntimeEnvironmentIdForWorktree,
  type WorktreeRuntimeOwnerState
} from '@/lib/worktree-runtime-owner'
import {
  importExternalPathsToRuntime,
  type RuntimeFileOperationArgs
} from '@/runtime/runtime-file-client'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { captureWorktreeSshMutationExpectation } from '@/lib/ssh-mutation-expectation'
import { statUserOpenedPath } from '@/lib/user-opened-local-path'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { openDocumentInFloatingWorkspace } from '@/lib/open-document-in-floating-workspace'

export function getEditorFileDropSettingsForWorktree(
  store: WorktreeRuntimeOwnerState,
  worktreeId: string
): Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> {
  const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(store, worktreeId)
  // Why: OS drops target the selected worktree. Use that worktree's host owner
  // so a focused runtime cannot hijack local/SSH editor drops.
  return {
    ...store.settings,
    activeRuntimeEnvironmentId: runtimeEnvironmentId
  }
}

export function shouldUploadRemoteEditorFileDrop(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  connectionId: string | null | undefined
): boolean {
  return Boolean(settings?.activeRuntimeEnvironmentId?.trim() || connectionId?.trim())
}

export function getEditorFileDropOperationContext(
  store: WorktreeRuntimeOwnerState,
  worktreeId: string,
  worktreePath: string | null | undefined,
  connectionId: string | undefined
): RuntimeFileOperationArgs {
  return {
    settings: getEditorFileDropSettingsForWorktree(store, worktreeId),
    worktreeId,
    worktreePath,
    connectionId
  }
}

export type EditorFileDropDestination = {
  worktreeId: string
  /** When omitted, the store chooses this workspace's default editor destination. */
  groupId?: string
}

type EditorFileDropContext = {
  fileContext: RuntimeFileOperationArgs
  worktreePath: string | undefined
  connectionId: string | undefined
}

function captureEditorFileDropContext(worktreeId: string): EditorFileDropContext | null {
  const store = useAppStore.getState()
  const worktreePath = store.getKnownWorktreeById(worktreeId)?.path
  const connectionId = getConnectionId(worktreeId) ?? undefined
  try {
    return {
      fileContext: {
        ...getEditorFileDropOperationContext(store, worktreeId, worktreePath, connectionId),
        ...captureWorktreeSshMutationExpectation(store, worktreeId)
      },
      worktreePath,
      connectionId
    }
  } catch {
    return null
  }
}

function sameEditorFileDropOwner(a: EditorFileDropContext, b: EditorFileDropContext): boolean {
  const left = a.fileContext
  const right = b.fileContext
  return (
    a.worktreePath === b.worktreePath &&
    a.connectionId === b.connectionId &&
    left.settings?.activeRuntimeEnvironmentId === right.settings?.activeRuntimeEnvironmentId &&
    left.expectedExecutionHostId === right.expectedExecutionHostId &&
    left.expectedSshTargetId === right.expectedSshTargetId &&
    left.expectedSshConnectionGeneration === right.expectedSshConnectionGeneration
  )
}

function showOwnerChangedError(): void {
  toast.error(
    translate(
      'auto.hooks.useGlobalFileDrop.ownerChanged',
      "Couldn't verify which host owns this workspace. Try again after it reconnects."
    )
  )
}

export function editorGroupStillExists({
  worktreeId,
  groupId
}: EditorFileDropDestination): boolean {
  if (!groupId) {
    return true
  }
  const groups = useAppStore.getState().groupsByWorktree[worktreeId] ?? []
  return groups.some((group) => group.id === groupId)
}

/**
 * Captures the destination workspace's host at drop time and returns the open
 * step; a host change before preparation finishes refuses instead of re-routing.
 */
export function captureEditorFileDropOpen(
  destination: EditorFileDropDestination
): (paths: readonly string[]) => Promise<void> {
  const captured = captureEditorFileDropContext(destination.worktreeId)
  if (!captured) {
    showOwnerChangedError()
    return async () => undefined
  }
  return async (paths) => {
    if (paths.length === 0 || !editorGroupStillExists(destination)) {
      return
    }
    const current = captureEditorFileDropContext(destination.worktreeId)
    if (!current || !sameEditorFileDropOwner(captured, current)) {
      showOwnerChangedError()
      return
    }
    await openEditorFileDropPaths(captured, destination, paths)
  }
}

async function openEditorFileDropPaths(
  { fileContext, worktreePath, connectionId }: EditorFileDropContext,
  destination: EditorFileDropDestination,
  paths: readonly string[]
): Promise<void> {
  const store = useAppStore.getState()
  const { worktreeId, groupId } = destination
  const groupOptions = groupId ? { targetGroupId: groupId } : null
  const dropSettings = fileContext.settings
  const runtimeEnvironmentId = dropSettings?.activeRuntimeEnvironmentId ?? null
  if (shouldUploadRemoteEditorFileDrop(dropSettings, connectionId)) {
    if (!worktreePath) {
      toast.error(
        translate(
          'auto.hooks.useGlobalFileDrop.245faa95b9',
          'No remote workspace path is available for dropped files.'
        )
      )
      return
    }
    try {
      // Why: OS file drops provide client-local paths. Remote runtime and
      // SSH editors must upload into the server worktree before opening.
      const destinationDir = joinPath(worktreePath, '.orca/drops')
      const { results } = await importExternalPathsToRuntime(
        fileContext,
        [...paths],
        destinationDir,
        { ensureDestinationDir: true }
      )
      if (!editorGroupStillExists(destination)) {
        return
      }
      for (const result of results) {
        if (!editorGroupStillExists(destination)) {
          return
        }
        if (result.status !== 'imported' || result.kind === 'directory') {
          continue
        }
        const maybeRelative = toWorktreeRelativePath(result.destPath, worktreePath)
        store.setActiveTabType('editor', worktreeId)
        store.openFile(
          {
            filePath: result.destPath,
            relativePath: maybeRelative ?? result.destPath,
            worktreeId,
            runtimeEnvironmentId: runtimeEnvironmentId ?? undefined,
            language: detectLanguage(result.destPath),
            mode: 'edit'
          },
          { suppressActiveRuntimeFallback: runtimeEnvironmentId === null, ...groupOptions }
        )
      }
      if (results.some((result) => result.status !== 'imported')) {
        toast.error(
          translate(
            'auto.hooks.useGlobalFileDrop.d720e2f855',
            'Some dropped files could not be uploaded.'
          )
        )
      }
    } catch {
      toast.error(
        translate('auto.hooks.useGlobalFileDrop.38c9f034ff', 'Failed to upload dropped files.')
      )
    }
    return
  }

  // Sequential, so a multi-file drop opens its tabs in drop order.
  for (const filePath of paths) {
    try {
      const stat = await statUserOpenedPath(fileContext, filePath)
      if (!editorGroupStillExists(destination)) {
        return
      }
      if (stat.isDirectory) {
        continue
      }
      let relativePath = filePath
      // Why: a project link out of the project keeps its absolute path, so it reads as
      // user-named instead of being refused as a project file.
      if (worktreePath && !stat.escapesWorktree && isPathInsideWorktree(filePath, worktreePath)) {
        const maybeRelative = toWorktreeRelativePath(filePath, worktreePath)
        if (maybeRelative !== null && maybeRelative.length > 0) {
          relativePath = maybeRelative
        }
      }
      store.setActiveTabType('editor', worktreeId)
      if (worktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
        openDocumentInFloatingWorkspace(
          store.openFile,
          { filePath, relativePath },
          groupOptions ?? {}
        )
        continue
      }
      const file = {
        filePath,
        relativePath,
        worktreeId,
        language: detectLanguage(filePath),
        mode: 'edit' as const
      }
      if (groupOptions) {
        store.openFile(file, groupOptions)
      } else {
        store.openFile(file)
      }
    } catch {
      // Ignore files that cannot be stat'd.
    }
  }
}
