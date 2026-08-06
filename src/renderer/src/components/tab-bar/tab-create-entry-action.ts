import { detectLanguage } from '@/lib/language-detect'
import { joinPath } from '@/lib/path'
import { getRendererAppPlatform } from '@/lib/renderer-app-platform'
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
import {
  classifyTabEntryQuery,
  TAB_ENTRY_ABSOLUTE_PATH_REMOTE_BLOCKED_MESSAGE,
  type TabEntryActionClassification,
  type TabEntryOptionsContext
} from './tab-create-entry-classifier'
import { openAbsoluteTabEntryFile } from './tab-create-entry-absolute-file'
import {
  getTabEntryAllowAbsolutePaths,
  getTabEntryFileOperationContext,
  isTabEntryAbsolutePathAllowed
} from './tab-create-entry-local-path'
import type { TabEntryLocalPlatform } from './tab-create-entry-path-validation'
export {
  classifyTabEntryQuery,
  getTabEntryOptions,
  isTabEntryAbsolutePathLike,
  TAB_ENTRY_ABSOLUTE_PATH_REMOTE_BLOCKED_MESSAGE,
  validateNewTabEntryAbsolutePath,
  validateNewTabEntryRelativePath,
  type TabEntryActionClassification,
  type TabEntryClassification,
  type TabEntryOption,
  type TabEntryOptionsContext
} from './tab-create-entry-classifier'
export {
  createTabEntryAllowAbsolutePathsSelector,
  getTabEntryAllowAbsolutePaths,
  isTabEntryAbsolutePathAllowed
} from './tab-create-entry-local-path'

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
  authorizeExternalPath: (args: { targetPath: string }) => Promise<void>
  assertAbsolutePathAllowed: () => void
}

type OpenTabEntryWithOperationsArgs = {
  query: string
  fileList: RuntimeFileListState
  worktreeId: string
  groupId: string
  worktreePath: string
  runtimeContext: RuntimeFileOperationArgs
  activeRuntimeEnvironmentId: string | null
  allowAbsolutePaths: boolean
  localPlatform: TabEntryLocalPlatform
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
  allowAbsolutePaths,
  classification: selectedClassification,
  fileList,
  groupId,
  localPlatform,
  operations,
  query,
  runtimeContext,
  worktreeId,
  worktreePath
}: OpenTabEntryWithOperationsArgs): Promise<void> {
  const entryContext: TabEntryOptionsContext = { allowAbsolutePaths, localPlatform }
  const classification =
    selectedClassification ?? classifyTabEntryQuery(query, fileList, entryContext)
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

  if (classification.kind === 'absolute-file') {
    if (!allowAbsolutePaths) {
      throw new Error(TAB_ENTRY_ABSOLUTE_PATH_REMOTE_BLOCKED_MESSAGE)
    }
    await openAbsoluteTabEntryFile({
      context: runtimeContext,
      groupId,
      operations,
      filePath: classification.filePath,
      localPlatform,
      worktreeId,
      worktreePath
    })
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
  const runtimeContext = getTabEntryFileOperationContext(state, args.worktreeId, worktree.path)
  const allowAbsolutePaths = isTabEntryAbsolutePathAllowed(runtimeContext)
  const localPlatform = getRendererAppPlatform() === 'win32' ? 'windows' : 'posix'
  await openTabEntryWithOperations({
    query: args.query,
    fileList: args.fileList,
    worktreeId: args.worktreeId,
    groupId: args.groupId,
    worktreePath: worktree.path,
    runtimeContext,
    activeRuntimeEnvironmentId: runtimeContext.settings?.activeRuntimeEnvironmentId?.trim() ?? null,
    allowAbsolutePaths,
    localPlatform,
    classification: args.classification,
    operations: {
      createBrowserTab: state.createBrowserTab,
      createRuntimePath,
      createWebRuntimeSessionBrowserTab,
      isWebRuntimeSessionActive,
      openFile: state.openFile,
      statRuntimePath,
      authorizeExternalPath: window.api.fs.authorizeExternalPath,
      assertAbsolutePathAllowed: () => {
        if (!getTabEntryAllowAbsolutePaths(useAppStore.getState(), args.worktreeId)) {
          throw new Error(TAB_ENTRY_ABSOLUTE_PATH_REMOTE_BLOCKED_MESSAGE)
        }
      }
    }
  })
}
