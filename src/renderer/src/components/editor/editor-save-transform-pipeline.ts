import type { OpenFile } from '@/store/slices/editor'
import type { AppStoreApi } from './editor-save-queue'
import type { EditorSaveRequest } from './editor-save-slots'
import { EditorSaveDiscardedError, editorDiscardEpoch } from './editor-discard-epoch'
import { editorFormatOnSave } from './editor-format-on-save'
import { editorSavePluginHook } from './editor-save-plugin-hook'

export function editorSaveTransform(
  store: AppStoreApi,
  file: OpenFile,
  request: EditorSaveRequest,
  text: string
): Promise<string> | null {
  if (!('operation' in request.invocation)) {
    throw request.invocation.error
  }
  const { operation } = request.invocation
  const formatted = editorFormatOnSave(
    store,
    file,
    operation.mutationContext(),
    request.trigger,
    text,
    () => {
      operation.assertAuthorityCurrent()
      if (editorDiscardEpoch(request.recordId) !== request.discardEpoch) {
        throw new EditorSaveDiscardedError()
      }
    }
  )
  const hook = (content: string) => editorSavePluginHook(store, file, request.trigger, content)
  return formatted ? formatted.then((content) => hook(content) ?? content) : hook(text)
}
