import { prepareQuickOpenFiles, rankQuickOpenFiles } from '../../../shared/quick-open-path-search'
import { statUserOpenedPath } from '@/lib/user-opened-local-path'
import { detectLanguage } from '@/lib/language-detect'
import { joinPath, getRelativePathInsideRoot } from '@/lib/path'
import { useAppStore } from '@/store'
import { isMissingRuntimePathError } from '@/runtime/runtime-file-client'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import type { RuntimeTerminalPathResolution } from '../../../shared/runtime-file-contracts'
import { resolveWslRepoWorktreeBasePath } from '../../../shared/wsl-paths'
import {
  isQuickOpenAbsolutePath,
  type QuickOpenQueryTarget
} from '../../../shared/quick-open-query-target'
import { scheduleEditorLineReveal } from '@/store/slices/editor/focus/editor-focus-reveal'
import {
  captureFileExplorerOperationGuard,
  getFileExplorerOperationOwner
} from './right-sidebar/file-explorer-operation-owner'

export async function openQuickOpenFile(
  selectedPath: string,
  worktreeId: string,
  root: string,
  navigation: QuickOpenQueryTarget,
  rawQuery?: string,
  assertInteractionCurrent: () => void = () => {}
): Promise<void> {
  const guard = captureFileExplorerOperationGuard(
    worktreeId,
    getFileExplorerOperationOwner(worktreeId)
  )
  const assertCurrent = (): void => {
    guard.assertCurrent()
    assertInteractionCurrent()
  }
  assertCurrent()
  const route = guard.route
  const target = route.target
  const resolvePastedPath = (path: string): string =>
    target.kind !== 'environment' &&
    !route.connectionId &&
    window.api.platform?.get().platform === 'win32'
      ? resolveWslRepoWorktreeBasePath(root, path)
      : path
  const isAbsolute = isQuickOpenAbsolutePath(selectedPath)
  let filePath = isAbsolute ? resolvePastedPath(selectedPath) : joinPath(root, selectedPath)
  let relativePath = getRelativePathInsideRoot(filePath, root) ?? filePath
  const context = { ...route, worktreeId, worktreePath: root }
  const literalQuery = rawQuery?.trim().replace(/\\/g, '/')
  const normalizedSelection = selectedPath.replace(/\\/g, '/')
  let literalSelected = Boolean(
    literalQuery &&
    (normalizedSelection === literalQuery ||
      normalizedSelection.endsWith(`/${literalQuery}`) ||
      (navigation.line !== undefined &&
        normalizedSelection.endsWith(literalQuery.slice(navigation.pathQuery.length)) &&
        rankQuickOpenFiles(literalQuery, prepareQuickOpenFiles([normalizedSelection]), 1).length >
          0))
  )
  if (isAbsolute && rawQuery && rawQuery.trim() !== selectedPath && target.kind !== 'environment') {
    try {
      const literalPath = resolvePastedPath(rawQuery.trim())
      const literalStats = await statUserOpenedPath(context, literalPath)
      assertCurrent()
      if (literalStats.isDirectory) {
        throw new Error('Choose a file rather than a directory.')
      }
      filePath = literalPath
      relativePath = literalStats.escapesWorktree
        ? filePath
        : (getRelativePathInsideRoot(filePath, root) ?? filePath)
      literalSelected = true
    } catch (error) {
      if (!isMissingRuntimePathError(error)) {
        throw error
      }
    }
  }
  if (target.kind === 'environment' && isAbsolute) {
    let literal: RuntimeTerminalPathResolution | undefined
    if (rawQuery && rawQuery.trim() !== selectedPath) {
      literal = await callRuntimeRpc<RuntimeTerminalPathResolution>(
        target,
        'files.resolveTerminalPath',
        {
          worktree: toRuntimeWorktreeSelector(worktreeId),
          pathText: rawQuery.trim()
        }
      )
      assertCurrent()
      literalSelected = literal.exists
    }
    const resolved =
      literalSelected && literal
        ? literal
        : await callRuntimeRpc<RuntimeTerminalPathResolution>(target, 'files.resolveTerminalPath', {
            worktree: toRuntimeWorktreeSelector(worktreeId),
            pathText: filePath
          })
    assertCurrent()
    if (!resolved.exists || resolved.isDirectory || !resolved.absolutePath) {
      throw new Error('The host could not open this file path.')
    }
    if (resolved.relativePath === null) {
      throw new Error(
        'This host cannot open a pasted path outside the workspace. Add its folder as a workspace first.'
      )
    }
    filePath = resolved.absolutePath
    relativePath = resolved.relativePath
  } else {
    const stats = await statUserOpenedPath(context, filePath)
    assertCurrent()
    if (stats.escapesWorktree) {
      relativePath = filePath
    }
    if (stats.isDirectory) {
      throw new Error('Choose a file rather than a directory.')
    }
  }
  assertCurrent()
  const store = useAppStore.getState()
  const fileId = store.openFile({
    filePath,
    relativePath,
    worktreeId,
    runtimeEnvironmentId: target.kind === 'environment' ? target.environmentId : null,
    ...(route.connectionId && getRelativePathInsideRoot(filePath, root) === null
      ? { externalSshTargetId: route.connectionId }
      : {}),
    language: detectLanguage(filePath),
    mode: 'edit'
  })
  if (!literalSelected && navigation.line !== undefined) {
    if (detectLanguage(filePath) === 'markdown') {
      useAppStore.getState().setMarkdownViewMode(fileId, 'source')
    }
    scheduleEditorLineReveal(
      useAppStore.getState,
      filePath,
      navigation.line,
      navigation.column,
      fileId
    )
  }
}
