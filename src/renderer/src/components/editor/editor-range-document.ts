import { pluginFramesIsolated } from '@/store/plugin-frame-isolation'
import {
  collectActivePluginCustomEditors,
  customEditorsForFile,
  resolveCustomEditorChoice,
  useCustomEditorViewStore
} from '@/store/plugin-custom-editors'
import { usePluginPanelsStore } from '@/store/plugin-panels'
import { matchPluginFile } from '../../../../shared/plugins/contributions/plugin-file-match'
import type { FileContent } from './editor-panel-content-types'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import type { AppState } from '@/store/types'
import type { RuntimeFileReadArgs } from '@/runtime/runtime-file-client-types'
import { openRuntimeRangeDocument } from '@/runtime/open-runtime-range-document'
import { isEditorModelDirty } from './save/queue/editor-save-disk-precondition'

export const EDITOR_RANGE_DIRTY_MESSAGE =
  'Save or discard unsaved changes before reading file ranges, then reload explicitly.'

export function isEditorRangeDocumentDirty(
  state: AppState,
  fileId: string,
  fallback?: OpenFile
): boolean {
  const file = state.openFiles.find((tab) => tab.id === fileId) ?? fallback
  return file !== undefined && isEditorModelDirty(state, file)
}

/** Ranges describe saved file bytes; a shared editor draft invalidates that file-backed view. */
export async function openEditorRangeDocument(
  args: RuntimeFileReadArgs,
  fileId: string,
  fallback?: OpenFile
) {
  const assertClean = () => {
    if (isEditorRangeDocumentDirty(useAppStore.getState(), fileId, fallback)) {
      throw Object.assign(new Error(EDITOR_RANGE_DIRTY_MESSAGE), { code: 'range_document_dirty' })
    }
  }
  const document = await openRuntimeRangeDocument(args, assertClean)
  try {
    assertClean()
  } catch (error) {
    document.dispose()
    throw error
  }
  const unsubscribe = useAppStore.subscribe((state, previous) => {
    if (
      state.openFiles === previous.openFiles &&
      state.editorBufferIdOf === previous.editorBufferIdOf &&
      state.editorBufferViews === previous.editorBufferViews
    ) {
      return
    }
    if (isEditorRangeDocumentDirty(state, fileId, fallback)) {
      document.invalidate()
    }
  })
  const dispose = document.onDispose
  document.onDispose = () => {
    unsubscribe()
    dispose?.()
  }
  return document
}

export async function readEditorRangeFileContent({
  args,
  fileId,
  file,
  previous,
  replaceRangeDocument,
  isCurrent,
  readSource
}: {
  args: RuntimeFileReadArgs
  fileId: string
  file?: OpenFile
  previous?: FileContent
  replaceRangeDocument?: true
  isCurrent: () => boolean
  readSource: () => Promise<FileContent>
}): Promise<FileContent> {
  const isolated = pluginFramesIsolated()
  const candidates = customEditorsForFile(
    args.filePath,
    collectActivePluginCustomEditors(usePluginPanelsStore.getState().plugins),
    isolated
  )
  const chosen = resolveCustomEditorChoice(
    candidates,
    useCustomEditorViewStore.getState().choices[fileId]
  )
  const ranges = candidates.filter(
    (editor) =>
      editor.contentKind === 'bytes' &&
      editor.documentAccess === 'ranges' &&
      (editor.frame !== 'isolated' || isolated)
  )
  const selected = chosen && ranges.includes(chosen) ? chosen : null
  if (selected && args.terminalArtifactGrantId) {
    throw new Error(
      'Ranged documents do not support terminal artifact grants. Open the file through its owning workspace.'
    )
  }
  const rangeSourceKey = JSON.stringify({ ...args, wakeWslDistro: undefined })
  if (selected && !isEditorRangeDocumentDirty(useAppStore.getState(), fileId, file)) {
    const source =
      !replaceRangeDocument && previous?.rangeSourceKey === rangeSourceKey && previous.rangeDocument
        ? previous.rangeDocument
        : await openEditorRangeDocument(args, fileId, file).catch((error: unknown) => {
            if (
              error &&
              typeof error === 'object' &&
              'code' in error &&
              error.code === 'range_document_dirty'
            ) {
              return null
            }
            throw error
          })
    if (source) {
      if (!isCurrent()) {
        if (source !== previous?.rangeDocument) {
          source.dispose()
        }
        return { content: '', isBinary: true }
      }
      if (matchPluginFile(args.filePath, selected) !== null || source.descriptor.isBinary) {
        return {
          content: '',
          isBinary: source.descriptor.isBinary,
          size: source.descriptor.byteLength,
          byteSource: args,
          rangeDocument: source,
          rangeSourceKey
        }
      }
      source.dispose()
    }
  }
  const result = await readSource()
  return (result.isBinary || ranges.length > 0) && !args.terminalArtifactGrantId
    ? { ...result, byteSource: args }
    : result
}
