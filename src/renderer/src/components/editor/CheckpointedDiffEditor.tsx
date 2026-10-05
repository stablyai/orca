import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { DiffEditor, type DiffEditorProps, type DiffOnMount } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import {
  flushEditorModelContentCheckpoint,
  hasPendingEditorModelContent,
  isCurrentEditorModelContent,
  isStaleEditorModelContent,
  withEditorModelContentSync
} from './editor-model-content-checkpoint'
import { syncContentOnMount, syncContentUpdate } from './monaco-content-sync'

/** Orca owns modified-model reconciliation so React echoes cannot replace pending input. */
export function CheckpointedDiffEditor({
  modified = '',
  onMount,
  onBeforeUnmount,
  ...props
}: DiffEditorProps & {
  onBeforeUnmount?: (editor: editor.IStandaloneDiffEditor) => void
}): React.JSX.Element {
  const [initialModified] = useState(modified)
  const [modifiedEditor, setModifiedEditor] = useState<editor.ICodeEditor | null>(null)
  const committed = useRef({ modified, onMount, onBeforeUnmount })
  const diffEditorRef = useRef<editor.IStandaloneDiffEditor | null>(null)
  const lastSyncedContent = useRef(modified)
  useLayoutEffect(() => {
    committed.current = { modified, onMount, onBeforeUnmount }
  }, [modified, onMount, onBeforeUnmount])
  useLayoutEffect(
    () => () => {
      if (diffEditorRef.current) {
        committed.current.onBeforeUnmount?.(diffEditorRef.current)
      }
    },
    []
  )

  const handleMount: DiffOnMount = useCallback((diffEditor, monaco) => {
    diffEditorRef.current = diffEditor
    const modifiedEditor = diffEditor.getModifiedEditor()
    const model = modifiedEditor.getModel()
    const content = committed.current.modified
    if (model) {
      if (hasPendingEditorModelContent(model)) {
        // Why: a newly mounted sibling may still have props from before the last keystroke.
        flushEditorModelContentCheckpoint(model)
      } else {
        withEditorModelContentSync(model, () => syncContentOnMount(modifiedEditor, content))
      }
    }
    lastSyncedContent.current = content
    setModifiedEditor(modifiedEditor)
    committed.current.onMount?.(diffEditor, monaco)
  }, [])

  useLayoutEffect(() => {
    if (!modifiedEditor || lastSyncedContent.current === modified) {
      return
    }
    const model = modifiedEditor.getModel()
    if (!model) {
      return
    }
    if (
      !isStaleEditorModelContent(model, modified) &&
      !isCurrentEditorModelContent(model, modified)
    ) {
      flushEditorModelContentCheckpoint(model)
      withEditorModelContentSync(model, () => syncContentUpdate(modifiedEditor, modified))
    }
    lastSyncedContent.current = modified
  }, [modified, modifiedEditor])

  return <DiffEditor {...props} modified={initialModified} onMount={handleMount} />
}
