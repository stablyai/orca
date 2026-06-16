import { detectLanguage } from '@/lib/language-detect'
import { getConnectionId } from '@/lib/connection-context'
import { joinPath } from '@/lib/path'
import {
  createRuntimePath,
  statRuntimePath,
  type RuntimeFileOperationArgs
} from '@/runtime/runtime-file-client'
import {
  createWebRuntimeSessionBrowserTab,
  isWebRuntimeSessionActive
} from '@/runtime/web-runtime-session'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import type { BrowserTab as BrowserTabState } from '../../../../shared/types'
import type { RuntimeFileListState } from '../quick-open-file-list'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import {
  classifyTabEntryQuery,
  type TabEntryActionClassification
} from './tab-create-entry-classifier'
export {
  classifyTabEntryQuery,
  getTabEntryOptions,
  validateNewTabEntryRelativePath,
  type TabEntryActionClassification,
  type TabEntryClassification,
  type TabEntryOption
} from './tab-create-entry-classifier'

export type TabCreateEntryArgs = {
  classification?: TabEntryActionClassification
  query: string
  worktreeId: string
  groupId: string
  fileList: RuntimeFileListState
}

export type TabEntryOperations = {
  createBrowserTab: (
    worktreeId: string,
    url: string,
    options?: {
      activate?: boolean
      browserRuntimeEnvironmentId?: string | null
      targetGroupId?: string
      title?: string
    }
  ) => BrowserTabState
  createRuntimePath: typeof createRuntimePath
  createWebRuntimeSessionBrowserTab: typeof createWebRuntimeSessionBrowserTab
  isWebRuntimeSessionActive: typeof isWebRuntimeSessionActive
  openFile: (
    file: Omit<OpenFile, 'id' | 'isDirty'>,
    options?: { preview?: boolean; targetGroupId?: string }
  ) => void
  statRuntimePath: typeof statRuntimePath
}

type OpenTabEntryWithOperationsArgs = {
  query: string
  fileList: RuntimeFileListState
  worktreeId: string
  groupId: string
  worktreePath: string
  runtimeContext: RuntimeFileOperationArgs
  activeRuntimeEnvironmentId: string | null
  classification?: TabEntryActionClassification
  operations: TabEntryOperations
}

function isExistsError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /\bEEXIST\b|already exists|file exists/i.test(message)
}

async function createParentDirectoriesForNewFile(args: {
  context: RuntimeFileOperationArgs
  operations: TabEntryOperations
  relativePath: string
  worktreePath: string
}): Promise<void> {
  const directorySegments = args.relativePath.split('/').slice(0, -1)
  let currentPath = args.worktreePath

  for (const segment of directorySegments) {
    currentPath = joinPath(currentPath, segment)
    try {
      // Why: file creation authorizes the immediate parent before its own mkdir,
      // so nested new-file paths must materialize parents one level at a time.
      await args.operations.createRuntimePath(args.context, currentPath, 'directory')
    } catch (error) {
      if (!isExistsError(error)) {
        throw error
      }
      const stat = await args.operations.statRuntimePath(args.context, currentPath)
      if (!stat.isDirectory) {
        throw new Error(`Cannot create file because ${currentPath} is not a directory.`)
      }
    }
  }
}

async function openExistingFile(args: {
  context: RuntimeFileOperationArgs
  groupId: string
  operations: TabEntryOperations
  relativePath: string
  worktreeId: string
  worktreePath: string
}): Promise<void> {
  const filePath = joinPath(args.worktreePath, args.relativePath)
  let stat: Awaited<ReturnType<typeof statRuntimePath>>
  try {
    stat = await args.operations.statRuntimePath(args.context, filePath)
  } catch {
    throw new Error(`File no longer exists: ${args.relativePath}`)
  }
  if (stat.isDirectory) {
    throw new Error(`Cannot open a directory: ${args.relativePath}`)
  }
  args.operations.openFile(
    {
      filePath,
      relativePath: args.relativePath,
      worktreeId: args.worktreeId,
      language: detectLanguage(args.relativePath),
      mode: 'edit'
    },
    { preview: false, targetGroupId: args.groupId }
  )
}

export async function openTabEntryWithOperations({
  activeRuntimeEnvironmentId,
  classification: selectedClassification,
  fileList,
  groupId,
  operations,
  query,
  runtimeContext,
  worktreeId,
  worktreePath
}: OpenTabEntryWithOperationsArgs): Promise<void> {
  const classification = selectedClassification ?? classifyTabEntryQuery(query, fileList)
  if (classification.kind === 'empty' || classification.kind === 'blocked') {
    throw new Error(classification.message)
  }

  if (classification.kind === 'explicit-url' || classification.kind === 'host-url') {
    const runtimeSessionActive = operations.isWebRuntimeSessionActive(activeRuntimeEnvironmentId)
    if (runtimeSessionActive) {
      const created = await operations.createWebRuntimeSessionBrowserTab({
        worktreeId,
        environmentId: activeRuntimeEnvironmentId,
        url: classification.url,
        targetGroupId: groupId
      })
      if (created) {
        return
      }
      // Why: headless remote runtimes cannot host browser panes yet; a URL open
      // should still give the user a usable client-local browser tab.
      operations.createBrowserTab(worktreeId, classification.url, {
        activate: true,
        browserRuntimeEnvironmentId: null,
        targetGroupId: groupId,
        title: classification.url
      })
    } else {
      operations.createBrowserTab(worktreeId, classification.url, {
        activate: true,
        targetGroupId: groupId,
        title: classification.url
      })
    }
    return
  }

  if (classification.kind === 'existing-file') {
    await openExistingFile({
      context: runtimeContext,
      groupId,
      operations,
      relativePath: classification.relativePath,
      worktreeId,
      worktreePath
    })
    return
  }

  const filePath = joinPath(worktreePath, classification.relativePath)
  try {
    await createParentDirectoriesForNewFile({
      context: runtimeContext,
      operations,
      relativePath: classification.relativePath,
      worktreePath
    })
    await operations.createRuntimePath(runtimeContext, filePath, 'file')
  } catch (error) {
    if (!isExistsError(error)) {
      throw error
    }
  }
  await openExistingFile({
    context: runtimeContext,
    groupId,
    operations,
    relativePath: classification.relativePath,
    worktreeId,
    worktreePath
  })
}

export async function openTabBarEntry(args: TabCreateEntryArgs): Promise<void> {
  const state = useAppStore.getState()
  const worktree = state.getKnownWorktreeById(args.worktreeId)
  if (!worktree) {
    throw new Error('No active worktree.')
  }
  const runtimeContext: RuntimeFileOperationArgs = {
    settings: {
      activeRuntimeEnvironmentId: getRuntimeEnvironmentIdForWorktree(state, args.worktreeId)
    },
    worktreeId: args.worktreeId,
    worktreePath: worktree.path,
    connectionId: getConnectionId(args.worktreeId) ?? undefined
  }
  await openTabEntryWithOperations({
    query: args.query,
    fileList: args.fileList,
    worktreeId: args.worktreeId,
    groupId: args.groupId,
    worktreePath: worktree.path,
    runtimeContext,
    activeRuntimeEnvironmentId: runtimeContext.settings?.activeRuntimeEnvironmentId?.trim() ?? null,
    classification: args.classification,
    operations: {
      createBrowserTab: state.createBrowserTab,
      createRuntimePath,
      createWebRuntimeSessionBrowserTab,
      isWebRuntimeSessionActive,
      openFile: state.openFile,
      statRuntimePath
    }
  })
}
