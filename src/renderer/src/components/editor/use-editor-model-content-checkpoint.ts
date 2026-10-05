import { useLayoutEffect, useRef } from 'react'
import type { editor } from 'monaco-editor'
import {
  registerEditorModelContentCheckpoint,
  type CheckpointTextModel,
  type EditorModelCheckpointBinding
} from './editor-model-content-checkpoint'

export function useEditorModelContentCheckpoint({
  editor: editorInstance,
  enabled,
  fileId,
  ownerKey,
  publish,
  onPending,
  shouldIgnore
}: EditorModelCheckpointBinding & {
  editor: {
    getModel: () => CheckpointTextModel | null
    onDidChangeModel: editor.ICodeEditor['onDidChangeModel']
  } | null
  enabled: boolean
  ownerKey?: string
}): void {
  const committed = useRef({ publish, onPending, shouldIgnore })
  useLayoutEffect(() => {
    committed.current = { publish, onPending, shouldIgnore }
  }, [onPending, publish, shouldIgnore])

  useLayoutEffect(() => {
    if (!editorInstance || !enabled) {
      return
    }
    let unregister: (() => void) | undefined
    const bindModel = (): void => {
      unregister?.()
      const model = editorInstance.getModel()
      unregister = model
        ? registerEditorModelContentCheckpoint(model, {
            fileId,
            publish: (content) => committed.current.publish(content),
            onPending: () => committed.current.onPending?.(),
            shouldIgnore: () => committed.current.shouldIgnore?.() ?? false
          })
        : undefined
    }
    bindModel()
    const subscription = editorInstance.onDidChangeModel(bindModel)
    return () => {
      subscription.dispose()
      unregister?.()
    }
  }, [editorInstance, enabled, fileId, ownerKey])
}
