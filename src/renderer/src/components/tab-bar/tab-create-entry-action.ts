import { detectLanguage } from '@/lib/language-detect'
import { joinPath } from '@/lib/path'
import { getRendererAppPlatform } from '@/lib/renderer-app-platform'
import { createRuntimePath } from '@/runtime/runtime-file-mutation-client'
import { statRuntimePath } from '@/runtime/runtime-file-metadata-client'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client-types'
import { useAppStore } from '@/store'
import {
  buildSearchUrl,
  DEFAULT_SEARCH_ENGINE,
  type SearchEngine,
  type SearchUrlOptions
} from '../../../../shared/browser-url'
import type { RuntimeFileListState } from '../quick-open-file-list'
import {
  openWorkspaceBrowserTab,
  type OpenWorkspaceBrowserTabRequest
} from '@/lib/workspace-browser-tab-open'
import {
  classifyTabEntryQuery,
  TAB_ENTRY_ABSOLUTE_PATH_REMOTE_BLOCKED_MESSAGE,
  type TabEntryActionClassification,
  type TabEntryOptionsContext
} from './tab-create-entry-classifier'
import { openAbsoluteTabEntryFile } from './tab-create-entry-absolute-file'
import {
  getTabEntryAllowAbsolutePaths,
  getTabEntryFileOperationContext
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
import { statUserOpenedPath } from '@/lib/user-opened-local-path'
import { openWorkspaceFile } from '@/lib/workspace-file-open'
import {
  assertEditorFileOperationCurrent,
  captureEditorFileOperationProvenance
} from '@/lib/editor-file-operation-owner'

export type TabCreateEntryArgs = {
  classification?: TabEntryActionClassification
  query: string
  worktreeId: string
  groupId: string
  fileList: RuntimeFileListState
}

export type TabEntryOperations = {
  createRuntimePath: typeof createRuntimePath
  openWorkspaceBrowserTab: typeof openWorkspaceBrowserTab
  openWorkspaceFile: typeof openWorkspaceFile
  statRuntimePath: typeof statRuntimePath
  statUserOpenedPath: typeof statUserOpenedPath
  assertAbsolutePathAllowed: () => void
}

type OpenTabEntryWithOperationsArgs = {
  query: string
  fileList: RuntimeFileListState
  worktreeId: string
  groupId: string
  getFileContext: () => {
    worktreePath: string
    runtimeContext: RuntimeFileOperationArgs
    assertCurrent: () => void
  }
  allowAbsolutePaths: boolean
  localPlatform: TabEntryLocalPlatform
  searchEngine: SearchEngine
  searchUrlOptions?: SearchUrlOptions
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

type NetworkTabEntryClassification = Extract<
  TabEntryActionClassification,
  { kind: 'explicit-url' | 'host-url' | 'search' }
>

function isNetworkTabEntry(
  entry: TabEntryActionClassification
): entry is NetworkTabEntryClassification {
  return entry.kind === 'explicit-url' || entry.kind === 'host-url' || entry.kind === 'search'
}

function getNetworkTabRequest(
  classification: NetworkTabEntryClassification,
  { worktreeId, groupId }: Pick<TabCreateEntryArgs, 'worktreeId' | 'groupId'>,
  searchUrlOptions?: SearchUrlOptions
): OpenWorkspaceBrowserTabRequest {
  const target = { workspaceId: worktreeId, targetGroupId: groupId }
  if (classification.kind === 'search') {
    return {
      ...target,
      url: buildSearchUrl(classification.query, classification.engine, searchUrlOptions),
      intent: { kind: 'search', engine: classification.engine }
    }
  }
  return { ...target, url: classification.url, intent: { kind: 'url' } }
}

export async function openTabEntryWithOperations({
  allowAbsolutePaths,
  classification: selectedClassification,
  fileList,
  groupId,
  localPlatform,
  operations,
  query,
  getFileContext,
  searchEngine,
  searchUrlOptions,
  worktreeId
}: OpenTabEntryWithOperationsArgs): Promise<void> {
  const entryContext: TabEntryOptionsContext = { allowAbsolutePaths, localPlatform, searchEngine }
  const classification =
    selectedClassification ?? classifyTabEntryQuery(query, fileList, entryContext)
  if (classification.kind === 'empty' || classification.kind === 'blocked') {
    throw new Error(classification.message)
  }

  if (classification.kind === 'html-file-url') {
    operations.openWorkspaceFile({
      kind: 'preview',
      filePath: classification.filePath,
      worktreeId,
      targetGroupId: groupId
    })
    return
  }

  if (isNetworkTabEntry(classification)) {
    await operations.openWorkspaceBrowserTab(
      getNetworkTabRequest(classification, { worktreeId, groupId }, searchUrlOptions)
    )
    return
  }

  const { worktreePath, runtimeContext, assertCurrent } = getFileContext()

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

  const filePath = joinPath(worktreePath, classification.relativePath)
  if (classification.kind === 'new-file') {
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
  }
  let stat: Awaited<ReturnType<typeof statRuntimePath>>
  try {
    stat = await operations.statRuntimePath(runtimeContext, filePath)
  } catch {
    throw new Error(`File no longer exists: ${classification.relativePath}`)
  }
  assertCurrent()
  if (stat.isDirectory) {
    throw new Error(`Cannot open a directory: ${classification.relativePath}`)
  }
  operations.openWorkspaceFile({
    kind: 'file',
    intent: classification.kind === 'new-file' ? 'source' : 'default',
    file: {
      filePath,
      relativePath: classification.relativePath,
      worktreeId,
      language: detectLanguage(classification.relativePath),
      mode: 'edit'
    },
    options: { preview: false, targetGroupId: groupId }
  })
}

export async function openTabBarEntry(args: TabCreateEntryArgs): Promise<void> {
  const state = useAppStore.getState()
  const searchUrlOptions = { kagiSessionLink: state.browserKagiSessionLink }
  const allowAbsolutePaths = getTabEntryAllowAbsolutePaths(state, args.worktreeId)
  const localPlatform = getRendererAppPlatform() === 'win32' ? 'windows' : 'posix'
  await openTabEntryWithOperations({
    query: args.query,
    fileList: args.fileList,
    worktreeId: args.worktreeId,
    groupId: args.groupId,
    getFileContext: () => {
      const worktree = state.getKnownWorktreeById(args.worktreeId)
      if (!worktree) {
        throw new Error('No active worktree.')
      }
      const provenance = captureEditorFileOperationProvenance(
        state,
        args.worktreeId,
        undefined,
        false
      )
      return {
        worktreePath: worktree.path,
        runtimeContext: getTabEntryFileOperationContext(state, args.worktreeId, worktree.path),
        assertCurrent: () => {
          assertEditorFileOperationCurrent(useAppStore.getState(), args.worktreeId, provenance)
        }
      }
    },
    allowAbsolutePaths,
    localPlatform,
    searchEngine: state.browserDefaultSearchEngine ?? DEFAULT_SEARCH_ENGINE,
    searchUrlOptions,
    classification: args.classification,
    operations: {
      createRuntimePath,
      openWorkspaceBrowserTab,
      openWorkspaceFile,
      statRuntimePath,
      statUserOpenedPath,
      assertAbsolutePathAllowed: () => {
        if (!getTabEntryAllowAbsolutePaths(useAppStore.getState(), args.worktreeId)) {
          throw new Error(TAB_ENTRY_ABSOLUTE_PATH_REMOTE_BLOCKED_MESSAGE)
        }
      }
    }
  })
}
