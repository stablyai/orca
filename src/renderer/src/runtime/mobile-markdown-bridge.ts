import { getActiveTabNavOrder } from '@/components/tab-bar/group-tab-order'
import {
  ORCA_EDITOR_FILE_SAVED_EVENT,
  requestEditorFileSave,
  requestEditorSaveQuiesce,
  type EditorFileSavedDetail
} from '@/components/editor/editor-autosave'
import { flushPendingEditorChange } from '@/components/editor/editor-pending-flush'
import { getConnectionId } from '@/lib/connection-context'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { readRuntimeFileContent } from './runtime-file-client'
import { settingsForRuntimeOwner } from './runtime-rpc-client'
import {
  hashMarkdownContent,
  MOBILE_MARKDOWN_EDIT_MAX_BYTES,
  utf8ByteLength,
  type RuntimeMarkdownReadTabResult,
  type RuntimeMarkdownSaveTabResult,
  type RuntimeMobileMarkdownRequest,
  type RuntimeMobileMarkdownResponse
} from '../../../shared/mobile-markdown-document'

const MOBILE_MARKDOWN_READ_MAX_BYTES = 512 * 1024
const saveQueues = new Map<string, Promise<void>>()

type FileContent = {
  content: string
  isBinary: boolean
}

export function attachMobileMarkdownBridge(): () => void {
  if (typeof window.api.ui.onMobileMarkdownRequest !== 'function') {
    return () => {}
  }
  return window.api.ui.onMobileMarkdownRequest((request) => {
    void handleMobileMarkdownRequest(request)
  })
}

async function handleMobileMarkdownRequest(request: RuntimeMobileMarkdownRequest): Promise<void> {
  try {
    const result =
      request.operation === 'read'
        ? await readMobileMarkdownTab(request.worktreeId, request.tabId)
        : await saveMobileMarkdownTab(
            request.worktreeId,
            request.tabId,
            request.baseVersion,
            request.content
          )
    respond({ id: request.id, ok: true, result })
  } catch (error) {
    respond({
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

async function readMobileMarkdownTab(
  worktreeId: string,
  tabId: string
): Promise<RuntimeMarkdownReadTabResult> {
  const target = resolveMarkdownTarget(worktreeId, tabId)
  flushEditorState(target.sourceFile.id)
  const { content, source } = await readCurrentContent(target.sourceFile)
  const readOnlyReason = getReadOnlyReason(target.tab, target.sourceFile, content)
  return {
    tabId,
    filePath: target.sourceFile.filePath,
    relativePath: target.sourceFile.relativePath,
    content,
    isDirty: target.sourceFile.isDirty || source === 'draft',
    version: hashMarkdownContent(content),
    source,
    editable: readOnlyReason === undefined,
    ...(readOnlyReason ? { readOnlyReason } : {})
  }
}

async function saveMobileMarkdownTab(
  worktreeId: string,
  tabId: string,
  baseVersion: string,
  content: string
): Promise<RuntimeMarkdownSaveTabResult> {
  if (utf8ByteLength(content) > MOBILE_MARKDOWN_EDIT_MAX_BYTES) {
    throw new Error('file_too_large')
  }
  const target = resolveMarkdownTarget(worktreeId, tabId)
  return await enqueueMarkdownSave(target.sourceFile.id, async () => {
    const freshTarget = resolveMarkdownTarget(worktreeId, tabId)
    const readOnlyReason = getReadOnlyReason(freshTarget.tab, freshTarget.sourceFile, content)
    if (readOnlyReason) {
      throw new Error(readOnlyReason)
    }

    flushEditorState(freshTarget.sourceFile.id)
    const current = await readCurrentContent(freshTarget.sourceFile)
    const currentVersion = hashMarkdownContent(current.content)
    if (currentVersion !== baseVersion) {
      if (current.content === content) {
        // Why: duplicate mobile save taps can race behind the first successful
        // write; treat an already-saved identical file as success, not conflict.
        return {
          tabId,
          version: currentVersion,
          isDirty: false,
          content: current.content
        }
      }
      throw new Error('conflict')
    }

    const state = useAppStore.getState()
    const previousDraft = state.editorDrafts[freshTarget.sourceFile.id]
    const previousDirty = freshTarget.sourceFile.isDirty
    state.setEditorDraft(freshTarget.sourceFile.id, content)
    state.markFileDirty(freshTarget.sourceFile.id, true)
    let verified: string
    try {
      await waitForPositiveSave(freshTarget.sourceFile, content)
      verified = await readFileContent(freshTarget.sourceFile)
      if (verified !== content) {
        throw new Error('save_verification_failed')
      }
    } catch (error) {
      restoreFailedMobileSaveDraft(freshTarget.sourceFile.id, content, previousDraft, previousDirty)
      throw error
    }

    return {
      tabId,
      version: hashMarkdownContent(verified),
      isDirty: false,
      content: verified
    }
  })
}

function restoreFailedMobileSaveDraft(
  fileId: string,
  injectedContent: string,
  previousDraft: string | undefined,
  previousDirty: boolean
): void {
  const state = useAppStore.getState()
  const currentDraft = state.editorDrafts[fileId]
  if (currentDraft !== undefined && currentDraft !== injectedContent) {
    return
  }
  // Why: mobile save injects a desktop draft only to reuse the editor save path.
  // If save or verification fails, put the desktop editor back exactly as it was before.
  if (previousDraft === undefined) {
    state.clearEditorDraft(fileId)
  } else {
    state.setEditorDraft(fileId, previousDraft)
  }
  state.markFileDirty(fileId, previousDirty)
}

async function enqueueMarkdownSave<T>(fileId: string, save: () => Promise<T>): Promise<T> {
  const previous = saveQueues.get(fileId) ?? Promise.resolve()
  let releaseQueue: () => void = () => {}
  const current = new Promise<void>((resolve) => {
    releaseQueue = resolve
  })
  const queued = previous.catch(() => undefined).then(() => current)
  saveQueues.set(fileId, queued)
  await previous.catch(() => undefined)
  try {
    return await save()
  } finally {
    releaseQueue()
    if (saveQueues.get(fileId) === queued) {
      saveQueues.delete(fileId)
    }
  }
}

function resolveMarkdownTarget(
  worktreeId: string,
  tabId: string
): { tab: OpenFile; sourceFile: OpenFile } {
  const state = useAppStore.getState()
  const orderItem = getActiveTabNavOrder(state, worktreeId).find(
    (item) => item.type === 'editor' && (item.tabId === tabId || item.id === tabId)
  )
  const tabFileId = orderItem?.type === 'editor' ? orderItem.id : tabId
  const tab = state.openFiles.find(
    (file) => file.worktreeId === worktreeId && (file.id === tabFileId || file.id === tabId)
  )
  if (!tab || !isMarkdownTab(tab)) {
    throw new Error('tab_not_found')
  }
  const sourceFile =
    tab.mode === 'markdown-preview' && tab.markdownPreviewSourceFileId
      ? (state.openFiles.find(
          (file) => file.worktreeId === worktreeId && file.id === tab.markdownPreviewSourceFileId
        ) ?? tab)
      : tab
  return { tab, sourceFile }
}

function isMarkdownTab(file: OpenFile): boolean {
  if (file.mode !== 'edit' && file.mode !== 'markdown-preview') {
    return false
  }
  return file.language === 'markdown' || file.mode === 'markdown-preview'
}

function getReadOnlyReason(
  tab: OpenFile,
  sourceFile: OpenFile,
  content: string
): RuntimeMarkdownReadTabResult['readOnlyReason'] {
  if (tab.mode === 'markdown-preview') {
    return 'unsupported_preview'
  }
  if (sourceFile.isUntitled) {
    return 'unsupported_untitled'
  }
  if (utf8ByteLength(content) > MOBILE_MARKDOWN_EDIT_MAX_BYTES) {
    return 'file_too_large'
  }
  return undefined
}

async function readCurrentContent(
  file: OpenFile
): Promise<{ content: string; source: 'draft' | 'file' }> {
  const draft = useAppStore.getState().editorDrafts[file.id]
  if (draft !== undefined) {
    return { content: draft, source: 'draft' }
  }
  return { content: await readFileContent(file), source: 'file' }
}

async function readFileContent(file: OpenFile): Promise<string> {
  const connectionId = getConnectionId(file.worktreeId) ?? undefined
  const state = useAppStore.getState()
  const result = (await readRuntimeFileContent({
    settings: settingsForRuntimeOwner(state.settings, file.runtimeEnvironmentId),
    filePath: file.filePath,
    relativePath: file.relativePath,
    worktreeId: file.worktreeId,
    connectionId
  })) as FileContent
  if (result.isBinary) {
    throw new Error('binary_file')
  }
  if (utf8ByteLength(result.content) > MOBILE_MARKDOWN_READ_MAX_BYTES) {
    throw new Error('file_too_large')
  }
  return result.content
}

function flushEditorState(fileId: string): void {
  // Why: rich markdown serializes through a debounce. Mobile reads/saves must
  // observe desktop-visible text, not a stale draft from before that debounce.
  flushPendingEditorChange(fileId)
}

async function waitForPositiveSave(file: OpenFile, content: string): Promise<void> {
  let timeout: number | null = null
  let onSaved: ((event: Event) => void) | null = null
  const cleanup = (): void => {
    if (timeout !== null) {
      window.clearTimeout(timeout)
      timeout = null
    }
    if (onSaved) {
      window.removeEventListener(ORCA_EDITOR_FILE_SAVED_EVENT, onSaved as EventListener)
      onSaved = null
    }
  }
  const saved = new Promise<void>((resolve, reject) => {
    timeout = window.setTimeout(() => {
      cleanup()
      reject(new Error('save_timeout'))
    }, 20_000)
    onSaved = (event: Event): void => {
      const detail = (event as CustomEvent<EditorFileSavedDetail>).detail
      if (detail?.fileId !== file.id || detail.content !== content) {
        return
      }
      cleanup()
      resolve()
    }
    window.addEventListener(ORCA_EDITOR_FILE_SAVED_EVENT, onSaved as EventListener)
  })

  try {
    await requestEditorSaveQuiesce({ fileId: file.id })
    const liveFile = useAppStore.getState().openFiles.find((openFile) => openFile.id === file.id)
    if (!liveFile) {
      throw new Error('tab_not_found')
    }
    await requestEditorFileSave({ fileId: file.id, fallbackContent: content })
    await saved
  } catch (error) {
    cleanup()
    throw error
  }
}

function respond(response: RuntimeMobileMarkdownResponse): void {
  window.api.ui.respondMobileMarkdownRequest(response)
}
