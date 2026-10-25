import { useEffect, useEffectEvent, useRef, type RefObject } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { dirname, getRelativePathInsideRoot } from '@/lib/path'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { importExternalPathsToRuntime } from '@/runtime/runtime-file-import-client'
import { captureRuntimeEnvironmentRequestRevision } from '@/runtime/runtime-environment-revision'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client-types'
import { shouldIgnoreFileExplorerKeyTarget } from './useFileExplorerKeys'
import {
  captureFileExplorerOperationGuard,
  type FileExplorerOperationGuard
} from './file-explorer-operation-owner'
import type { FileExplorerOperationOwner, TreeNode } from './file-explorer-types'
import type { FileExplorerRowProjection } from './file-explorer-row-projection'
import {
  formatFileExplorerPathsForClipboard,
  selectFileExplorerSelectionRoots
} from './file-explorer-selection'

const CLIPBOARD_TYPE = 'application/x-orca-explorer-files'
type ExplorerClipboard = {
  token: string
  nodes: TreeNode[]
  context: RuntimeFileOperationArgs
  guard: FileExplorerOperationGuard
  pairingRevision: number | undefined
}
let copiedFiles: ExplorerClipboard | null = null

export function useFileExplorerClipboard(options: {
  containerRef: RefObject<HTMLDivElement | null>
  worktreeId: string | null
  worktreePath: string | null
  displayRootPath: string | null
  operationOwner: FileExplorerOperationOwner | undefined
  selectedPaths: Set<string>
  selectedNode: TreeNode | null
  rowProjection: FileExplorerRowProjection
  refreshDir: (path: string) => Promise<void>
}): void {
  const pending = useRef(false)
  const currentOptions = useEffectEvent(() => options)
  useEffect(() => {
    const ownsEvent = (
      event: ClipboardEvent,
      options: ReturnType<typeof currentOptions>
    ): boolean =>
      !!options.worktreeId &&
      !!options.worktreePath &&
      !!options.displayRootPath &&
      !!options.containerRef.current?.contains(document.activeElement) &&
      !shouldIgnoreFileExplorerKeyTarget(event.target)

    const onCopy = (event: ClipboardEvent): void => {
      const options = currentOptions()
      if (!ownsEvent(event, options) || !event.clipboardData) {
        return
      }
      const selected = options.rowProjection.getRowsByPaths(options.selectedPaths)
      const nodes = selected.length ? selected : options.selectedNode ? [options.selectedNode] : []
      if (!nodes.length) {
        return
      }
      copiedFiles = null
      try {
        const guard = captureFileExplorerOperationGuard(options.worktreeId, nodes[0].operationOwner)
        for (const node of nodes) {
          captureFileExplorerOperationGuard(options.worktreeId, node.operationOwner)
        }
        const target = guard.route.target
        copiedFiles = {
          token: createBrowserUuid(),
          nodes: selectFileExplorerSelectionRoots(nodes),
          context: {
            ...guard.route,
            worktreeId: options.worktreeId,
            worktreePath: options.worktreePath
          },
          guard,
          pairingRevision:
            target.kind === 'environment'
              ? captureRuntimeEnvironmentRequestRevision(target.environmentId)
              : undefined
        }
        event.clipboardData.setData(CLIPBOARD_TYPE, copiedFiles.token)
        event.clipboardData.setData(
          'text/plain',
          formatFileExplorerPathsForClipboard(copiedFiles.nodes, 'absolute')
        )
        event.preventDefault()
      } catch (error) {
        toast.error(
          extractIpcErrorMessage(
            error,
            translate('fileExplorer.clipboard.copyFailed', 'Could not copy files')
          )
        )
      }
    }

    const onPaste = (event: ClipboardEvent): void => {
      const options = currentOptions()
      const source = copiedFiles
      if (
        !ownsEvent(event, options) ||
        !source ||
        event.clipboardData?.getData(CLIPBOARD_TYPE) !== source.token
      ) {
        return
      }
      event.preventDefault()
      if (pending.current) {
        return
      }
      const node = options.selectedNode
      const destinationDir = node
        ? node.isDirectory
          ? node.path
          : dirname(node.path)
        : options.displayRootPath
      if (
        !destinationDir ||
        getRelativePathInsideRoot(destinationDir, options.displayRootPath) === null
      ) {
        return
      }
      const paste = async (): Promise<void> => {
        source.guard.assertCurrent()
        const destination = captureFileExplorerOperationGuard(
          options.worktreeId,
          node?.operationOwner ?? options.operationOwner
        )
        const context = {
          ...destination.route,
          worktreeId: options.worktreeId,
          worktreePath: options.worktreePath
        }
        const target = source.context.target
        let result
        if (target.kind === 'environment') {
          if (context.target.kind !== 'local' || context.connectionId) {
            throw new Error(
              translate(
                'fileExplorer.clipboard.localDestinationRequired',
                'Paste remote files into a local workspace'
              )
            )
          }
          if (source.pairingRevision === undefined || !source.context.worktreeId) {
            throw new Error(
              translate(
                'fileExplorer.clipboard.sourceChanged',
                'Reconnect to the source server and copy the files again'
              )
            )
          }
          const relativePaths = source.nodes.map((item) => {
            const path = getRelativePathInsideRoot(item.path, source.context.worktreePath ?? null)
            if (!path) {
              throw new Error(
                translate(
                  'fileExplorer.clipboard.outsideWorkspace',
                  'Source file is outside its workspace'
                )
              )
            }
            return path
          })
          result = await window.api.fs.importRuntimeFiles({
            environmentId: target.environmentId,
            worktree: toRuntimeWorktreeSelector(source.context.worktreeId),
            relativePaths,
            destinationDir,
            expectedEnvironmentPairingRevision: source.pairingRevision
          })
        } else {
          if (source.context.connectionId) {
            throw new Error(
              translate(
                'fileExplorer.clipboard.sshUnsupported',
                'Copying from SSH workspaces is not supported'
              )
            )
          }
          if (
            context.target.kind === 'local' &&
            !context.connectionId &&
            source.nodes.some(
              (item) =>
                item.isDirectory && getRelativePathInsideRoot(destinationDir, item.path) !== null
            )
          ) {
            throw new Error(
              translate('fileExplorer.clipboard.recursiveCopy', 'Cannot copy a folder into itself')
            )
          }
          result = await importExternalPathsToRuntime(
            context,
            source.nodes.map((item) => item.path),
            destinationDir,
            {
              assertCurrent: () => {
                source.guard.assertCurrent()
                destination.assertCurrent()
              }
            }
          )
        }
        const shown = currentOptions()
        if (
          shown.worktreeId === options.worktreeId &&
          shown.worktreePath === options.worktreePath &&
          JSON.stringify(shown.operationOwner) === JSON.stringify(options.operationOwner)
        ) {
          await options.refreshDir(destinationDir)
        }
        const failure = result.results.find((item) => item.status !== 'imported')
        if (failure && failure.status !== 'imported') {
          throw new Error(failure.reason)
        }
      }
      pending.current = true
      void showCopyProgress(paste()).finally(() => {
        pending.current = false
      })
    }
    document.addEventListener('copy', onCopy)
    document.addEventListener('paste', onPaste)
    return () => {
      document.removeEventListener('copy', onCopy)
      document.removeEventListener('paste', onPaste)
    }
  }, [])
}

async function showCopyProgress(operation: Promise<void>): Promise<void> {
  let notification: string | number | undefined
  const timer = setTimeout(() => {
    notification = toast.loading(translate('fileExplorer.clipboard.copying', 'Copying files…'))
  }, 250)
  try {
    await operation
  } catch (error) {
    toast.error(
      extractIpcErrorMessage(
        error,
        translate('fileExplorer.clipboard.pasteFailed', 'Could not paste files')
      )
    )
  } finally {
    clearTimeout(timer)
    if (notification !== undefined) {
      toast.dismiss(notification)
    }
  }
}
