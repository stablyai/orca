import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import type { editor } from 'monaco-editor'
import { installEditorSaveShortcut, installMonacoEditorFindShortcut } from './editor-shortcuts'

type DiffViewerEditingWiringInput = {
  editable: boolean
  modifiedEditor: editor.ICodeEditor | null
  diffEditorRef: RefObject<editor.IStandaloneDiffEditor | null>
  onContentChange?: (content: string) => void
  onSave?: (content: string) => void
}

/**
 * Owns the modified pane's Cmd+S bridge, both panes' find bridges, and the
 * change subscription.
 *
 * Why a hook and not DiffViewer's onMount: `editable` can flip on a live pane
 * (a failed diff load recovering under it) and @monaco-editor/react pins
 * onMount to the first render, so mount-time wiring would never be installed.
 * Remounting to force it would also re-run the mount-time focus grab and steal
 * keystrokes, because that recovery is an unattended background refetch.
 */
export function useDiffViewerEditingWiring({
  editable,
  modifiedEditor,
  diffEditorRef,
  onContentChange,
  onSave
}: DiffViewerEditingWiringInput): void {
  // Keep refs to latest callbacks so the mounted editor always calls current versions
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave
  const onContentChangeRef = useRef(onContentChange)
  onContentChangeRef.current = onContentChange

  useEffect(() => {
    if (!editable || !modifiedEditor) {
      return
    }
    const originalEditor = diffEditorRef.current?.getOriginalEditor()
    const cleanupSaveShortcut = installEditorSaveShortcut(
      modifiedEditor.getContainerDomNode(),
      () => {
        onSaveRef.current?.(modifiedEditor.getValue())
      }
    )
    const cleanupOriginalFindShortcut = originalEditor
      ? installMonacoEditorFindShortcut(originalEditor)
      : null
    const cleanupModifiedFindShortcut = installMonacoEditorFindShortcut(modifiedEditor)
    const modelContentSub = modifiedEditor.onDidChangeModelContent(() => {
      onContentChangeRef.current?.(modifiedEditor.getValue())
    })
    return () => {
      cleanupSaveShortcut()
      cleanupOriginalFindShortcut?.()
      cleanupModifiedFindShortcut()
      modelContentSub.dispose()
    }
  }, [editable, modifiedEditor, diffEditorRef])
}
