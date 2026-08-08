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
import type { RuntimeFileListState } from '../quick-open-file-list'
import {
  classifyTabEntryQuery,
  TAB_ENTRY_ABSOLUTE_PATH_REMOTE_BLOCKED_MESSAGE,
  type TabEntryActionClassification,
  type TabEntryOptionsContext
} from './tab-create-entry-classifier'
import { resolveBrowserTabTarget, type BrowserTabTarget } from '@/lib/browser-tab-host'
import { resolveWorktreeOperationRouteResult } from '@/lib/worktree-operation-route'
import { openAbsoluteTabEntryFile } from './tab-create-entry-absolute-file'
import {
  openBrowserTabEntryWithOperations,
  type BrowserTabEntryOperations
} from './tab-create-entry-browser-open'
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

export type TabEntryOperations = BrowserTabEntryOperations & {
  createRuntimePath: typeof createRuntimePath
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
  allowAbsolutePaths: boolean
  browserTabTarget: BrowserTabTarget
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
  allowAbsolutePaths,
  browserTabTarget,
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
    await openBrowserTabEntryWithOperations({
      browserTabTarget,
      groupId,
      operations,
      url: classification.url,
      worktreeId
    })
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
  const localPlatform = getRendererAppPlatform() === 'win32' ? 'windows' : 'posix'
  // Why: URL opening does not require file-mutation authority, so detect it before
  // disconnected SSH ownership guards.
  const browserClassification =
    args.classification ??
    classifyTabEntryQuery(args.query, args.fileList, {
      allowAbsolutePaths: false,
      localPlatform
    })
  const browserRoute = resolveWorktreeOperationRouteResult(state, args.worktreeId)
  const browserTabTarget = resolveBrowserTabTarget(state.settings?.browserTabHost, browserRoute)
  if (browserClassification.kind === 'explicit-url' || browserClassification.kind === 'host-url') {
    await openBrowserTabEntryWithOperations({
      browserTabTarget,
      groupId: args.groupId,
      operations: {
        createBrowserTab: state.createBrowserTab,
        createWebRuntimeSessionBrowserTab,
        isWebRuntimeSessionActive
      },
      url: browserClassification.url,
      worktreeId: args.worktreeId
    })
    return
  }
  const runtimeContext = getTabEntryFileOperationContext(state, args.worktreeId, worktree.path)
  const allowAbsolutePaths = isTabEntryAbsolutePathAllowed(runtimeContext)
  await openTabEntryWithOperations({
    query: args.query,
    fileList: args.fileList,
    worktreeId: args.worktreeId,
    groupId: args.groupId,
    worktreePath: worktree.path,
    runtimeContext,
    allowAbsolutePaths,
    browserTabTarget,
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
