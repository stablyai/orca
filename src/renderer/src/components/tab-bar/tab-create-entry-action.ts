import { detectLanguage } from '@/lib/language-detect'
import { joinPath } from '@/lib/path'
import { getRendererAppPlatform } from '@/lib/renderer-app-platform'
import { createRuntimePath } from '@/runtime/runtime-file-mutation-client'
import { statRuntimePath } from '@/runtime/runtime-file-metadata-client'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client-types'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import {
  DEFAULT_SEARCH_ENGINE,
  type SearchEngine,
  type SearchUrlOptions
} from '../../../../shared/browser-url'
import type { RuntimeFileListState } from '../quick-open-file-list'
import { openWorkspaceBrowserTab } from '@/lib/workspace-browser-tab-open'
import {
  classifyTabEntryQuery,
  getTabEntryAbsolutePathRemoteBlockedMessage,
  type TabEntryActionClassification,
  type TabEntryOptionsContext
} from './tab-create-entry-classifier'
import { openAbsoluteTabEntryFile } from './tab-create-entry-absolute-file'
import {
  getTabEntryCannotOpenDirectoryMessage,
  getTabEntryFileNoLongerExistsMessage,
  getTabEntryNoActiveWorktreeMessage,
  getTabEntryParentNotDirectoryMessage
} from './tab-create-entry-copy'
import { getNetworkTabRequest, isNetworkTabEntry } from './tab-create-entry-browser-request'
import {
  getTabEntryAllowAbsolutePaths,
  getTabEntryFileOperationContext
} from './tab-create-entry-local-path'
import type { TabEntryLocalPlatform } from './tab-create-entry-path-validation'
export {
  classifyTabEntryQuery,
  getTabEntryOptions,
  isTabEntryAbsolutePathLike,
  getTabEntryAbsolutePathRemoteBlockedMessage,
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
import { openHtmlFilePreview } from '@/lib/open-html-file-preview'
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
  openHtmlFilePreview: typeof openHtmlFilePreview
  openFile: (
    file: Omit<OpenFile, 'id' | 'isDirty'>,
    options?: { preview?: boolean; targetGroupId?: string }
  ) => void
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
      // Authorize each parent before creating the next nested directory.
      await args.operations.createRuntimePath(args.context, currentPath, 'directory')
    } catch (error) {
      if (!isExistsError(error)) {
        throw error
      }
      const stat = await args.operations.statRuntimePath(args.context, currentPath)
      if (!stat.isDirectory) {
        throw new Error(getTabEntryParentNotDirectoryMessage(currentPath))
      }
    }
  }
}

async function openExistingFile(args: {
  assertCurrent: () => void
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
    throw new Error(getTabEntryFileNoLongerExistsMessage(args.relativePath))
  }
  args.assertCurrent()
  if (stat.isDirectory) {
    throw new Error(getTabEntryCannotOpenDirectoryMessage(args.relativePath))
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
    operations.openHtmlFilePreview({
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
      throw new Error(getTabEntryAbsolutePathRemoteBlockedMessage())
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
      assertCurrent,
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
    assertCurrent,
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
        throw new Error(getTabEntryNoActiveWorktreeMessage())
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
      openHtmlFilePreview,
      openFile: state.openFile,
      statRuntimePath,
      statUserOpenedPath,
      assertAbsolutePathAllowed: () => {
        if (!getTabEntryAllowAbsolutePaths(useAppStore.getState(), args.worktreeId)) {
          throw new Error(getTabEntryAbsolutePathRemoteBlockedMessage())
        }
      }
    }
  })
}
