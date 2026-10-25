import { toast } from 'sonner'
import { detectLanguage } from '@/lib/language-detect'
import { isPathInsideWorktree, toWorktreeRelativePath } from '@/lib/terminal-links'
import { useAppStore } from '@/store'
import { getConnectionId } from '@/lib/connection-context'
import { basename, joinPath } from '@/lib/path'
import type { WorktreeRuntimeOwnerState } from '@/lib/worktree-runtime-owner-state'
import { importExternalPathsToRuntime } from '@/runtime/runtime-file-import-client'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client-types'
import { runtimeTargetEnvironmentId } from '@/runtime/runtime-client-target'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { translate } from '@/i18n/i18n'
import { captureWorktreeSshMutationExpectation } from '@/lib/ssh-mutation-expectation'
import { statUserOpenedPath } from '@/lib/user-opened-local-path'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { openDocumentInFloatingWorkspace } from '@/lib/open-document-in-floating-workspace'
import { requireRuntimeTargetForFileOwner } from '@/lib/file-owner-runtime-target'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import {
  isResolvedWorkspaceFileDragExecutionHost,
  type WorkspaceFileDragSource
} from '@/lib/workspace-file-drag'
import {
  captureFileExplorerOperationGuard,
  getFileExplorerOperationOwner
} from '../right-sidebar/file-explorer-operation-owner'

export function shouldUploadRemoteEditorFileDrop(
  target: RuntimeClientTarget,
  connectionId: string | null | undefined
): boolean {
  return target.kind === 'environment' || Boolean(connectionId?.trim())
}

export function getEditorFileDropOperationContext(
  store: WorktreeRuntimeOwnerState,
  worktreeId: string,
  worktreePath: string | null | undefined,
  connectionId: string | undefined
): RuntimeFileOperationArgs {
  return {
    // Why: OS drops target the selected worktree's owner, never the focused server.
    target: requireRuntimeTargetForFileOwner(store, worktreeId, undefined),
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
  assertCurrent?: () => void
}

function captureEditorFileDropContext(
  worktreeId: string,
  workspaceResource = false
): EditorFileDropContext | null {
  const store = useAppStore.getState()
  const worktreePath = store.getKnownWorktreeById(worktreeId)?.path
  try {
    if (workspaceResource) {
      const guard = captureFileExplorerOperationGuard(
        worktreeId,
        getFileExplorerOperationOwner(worktreeId)
      )
      return {
        fileContext: { ...guard.route, worktreeId, worktreePath },
        worktreePath,
        assertCurrent: guard.assertCurrent
      }
    }
    const connectionId = getConnectionId(worktreeId) ?? undefined
    return {
      fileContext: {
        ...getEditorFileDropOperationContext(store, worktreeId, worktreePath, connectionId),
        ...captureWorktreeSshMutationExpectation(store, worktreeId)
      },
      worktreePath
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
    left.connectionId === right.connectionId &&
    runtimeTargetEnvironmentId(left.target) === runtimeTargetEnvironmentId(right.target) &&
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

export function editorGroupStillExists(destination: EditorFileDropDestination): boolean {
  const { worktreeId, groupId } = destination
  return (
    !groupId ||
    !!useAppStore.getState().groupsByWorktree[worktreeId]?.some((group) => group.id === groupId)
  )
}

function canOpenEditorFileDrop(
  captured: EditorFileDropContext,
  destination: EditorFileDropDestination
): boolean {
  if (!editorGroupStillExists(destination)) {
    return false
  }
  try {
    if (captured.assertCurrent) {
      const state = useAppStore.getState()
      const { worktreeId, groupId } = destination
      const groups = state.groupsByWorktree[worktreeId] ?? []
      if (
        state.getKnownWorktreeById(worktreeId)?.path !== captured.worktreePath ||
        (groupId && groups.find((group) => group.id === groupId)?.worktreeId !== worktreeId)
      ) {
        throw new Error('Destination changed')
      }
      captured.assertCurrent()
    } else {
      const current = captureEditorFileDropContext(destination.worktreeId)
      if (!current || !sameEditorFileDropOwner(captured, current)) {
        throw new Error('Owner changed')
      }
    }
    return true
  } catch {
    showOwnerChangedError()
    return false
  }
}

/**
 * Captures the destination workspace's host at drop time and returns the open
 * step; a host change before preparation finishes refuses instead of re-routing.
 */
export function captureEditorFileDropOpen(
  destination: EditorFileDropDestination,
  source?: WorkspaceFileDragSource
): (paths: readonly string[]) => Promise<void> {
  const captured = captureEditorFileDropContext(destination.worktreeId, source !== undefined)
  const sourceHost = parseExecutionHostId(source?.executionHostId)
  if (!captured || (source && !isResolvedWorkspaceFileDragExecutionHost(source.executionHostId))) {
    showOwnerChangedError()
    return async () => undefined
  }
  if (
    source &&
    ((sourceHost?.kind === 'runtime' ? 'local' : source.executionHostId) !==
      captured.fileContext.expectedExecutionHostId ||
      (source.runtimeEnvironmentId ??
        (sourceHost?.kind === 'runtime' ? sourceHost.environmentId : null)) !==
        runtimeTargetEnvironmentId(captured.fileContext.target))
  ) {
    toast.error(
      translate(
        'auto.hooks.useGlobalFileDrop.hostMismatch',
        'This editor is on a different host. Open the file from its source workspace.'
      )
    )
    return async () => undefined
  }
  return (paths) =>
    paths.length > 0 && canOpenEditorFileDrop(captured, destination)
      ? openEditorFileDropPaths(captured, destination, paths, source === undefined)
      : Promise.resolve()
}

async function openEditorFileDropPaths(
  context: EditorFileDropContext,
  destination: EditorFileDropDestination,
  paths: readonly string[],
  clientLocalPaths: boolean
): Promise<void> {
  const { fileContext, worktreePath } = context
  const { connectionId } = fileContext
  const { openFile, setActiveTabType } = useAppStore.getState()
  const { worktreeId, groupId } = destination
  const groupOptions = groupId ? { targetGroupId: groupId } : null
  const runtimeEnvironmentId = runtimeTargetEnvironmentId(fileContext.target)
  if (clientLocalPaths && shouldUploadRemoteEditorFileDrop(fileContext.target, connectionId)) {
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
        { ensureDestinationDir: true, nameExtensionlessImages: true }
      )
      if (!canOpenEditorFileDrop(context, destination)) {
        return
      }
      for (const result of results) {
        if (!canOpenEditorFileDrop(context, destination)) {
          return
        }
        if (result.status !== 'imported' || result.kind === 'directory') {
          continue
        }
        const maybeRelative = toWorktreeRelativePath(result.destPath, worktreePath)
        setActiveTabType('editor', worktreeId)
        openFile(
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
    if (!clientLocalPaths && !canOpenEditorFileDrop(context, destination)) {
      return
    }
    try {
      const stat = await statUserOpenedPath(fileContext, filePath)
      if (!canOpenEditorFileDrop(context, destination)) {
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
      setActiveTabType('editor', worktreeId)
      const floating = worktreeId === FLOATING_TERMINAL_WORKTREE_ID
      if (clientLocalPaths && floating) {
        openDocumentInFloatingWorkspace(openFile, { filePath, relativePath }, groupOptions ?? {})
        continue
      }
      const file = {
        filePath,
        relativePath,
        worktreeId,
        language: detectLanguage(filePath),
        mode: 'edit' as const,
        runtimeEnvironmentId: floating ? null : (runtimeEnvironmentId ?? undefined)
      }
      if (!clientLocalPaths || groupOptions) {
        openFile(file, {
          ...groupOptions,
          ...(!clientLocalPaths
            ? { suppressActiveRuntimeFallback: runtimeEnvironmentId === null, focusEditor: true }
            : {}),
          ...(floating ? { preview: false, suppressActiveRuntimeFallback: true } : {})
        })
      } else {
        openFile(file)
      }
    } catch {
      if (!clientLocalPaths) {
        toast.error(
          translate(
            'auto.hooks.useGlobalFileDrop.workspaceOpenFailed',
            'Could not open {{fileName}}. Open it from its source workspace and try again.',
            { fileName: basename(filePath) }
          )
        )
      }
    }
  }
}
