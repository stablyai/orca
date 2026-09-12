import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type { editor } from 'monaco-editor'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { getMonacoCodebaseSearchQuery } from './monaco-codebase-search'
import { getDiffCommentPopoverLeft } from '../diff-comments/diff-comment-popover-position'
import {
  installEditorAddReviewNoteShortcut,
  installEditorSaveShortcut,
  installMonacoEditorCommandPaletteShortcut,
  installMonacoEditorFindShortcut
} from './editor-shortcuts'
import {
  getMonacoMarkdownSelectionAnnotationTarget,
  type MonacoMarkdownSelectionAnnotationTarget
} from './monaco-markdown-selection-annotation'
import { handleMonacoLargeTextPaste } from './monaco-large-text-paste'
import type { MarkdownCommentPopoverState } from './use-monaco-markdown-annotations'
import type { MonacoEditorPropsRef } from './monaco-editor-mount-params'

type MonacoEditorInputBindingsParams = {
  editorInstance: editor.IStandaloneCodeEditor
  worktreeId: string | undefined
  editorContainerRef: MutableRefObject<HTMLDivElement | null>
  propsRef: MonacoEditorPropsRef
  readOnlyRef: MutableRefObject<boolean>
  lastSyncedContentRef: MutableRefObject<string>
  isApplyingLargePasteRef: MutableRefObject<boolean>
  commentPopoverRef: MutableRefObject<MarkdownCommentPopoverState | null>
  shouldShowMarkdownAnnotationsRef: MutableRefObject<boolean>
  setCommentPopover: Dispatch<SetStateAction<MarkdownCommentPopoverState | null>>
  setSelectionAnnotationTarget: Dispatch<
    SetStateAction<MonacoMarkdownSelectionAnnotationTarget | null>
  >
}

// Why: save/find/review-note chords, the context-menu action, and the large-paste capture share one teardown so onDidDispose keeps their original order.
export function installMonacoEditorInputBindings(params: MonacoEditorInputBindingsParams): {
  disposeInputBindings: () => void
} {
  const {
    editorInstance,
    worktreeId,
    editorContainerRef,
    propsRef,
    readOnlyRef,
    lastSyncedContentRef,
    isApplyingLargePasteRef,
    commentPopoverRef,
    shouldShowMarkdownAnnotationsRef,
    setCommentPopover,
    setSelectionAnnotationTarget
  } = params

  const editorDomNode = editorInstance.getContainerDomNode()
  const cleanupSaveShortcut = installEditorSaveShortcut(editorDomNode, () => {
    const value = editorInstance.getValue()
    propsRef.current.onSave(value)
  })
  const cleanupFindShortcut = installMonacoEditorFindShortcut(editorInstance)
  const cleanupCommandPaletteShortcut = installMonacoEditorCommandPaletteShortcut(editorInstance)
  // Opens the same composer as the selection "+" button.
  const cleanupAddReviewNoteShortcut = installEditorAddReviewNoteShortcut(editorDomNode, () => {
    // Why: keep an open draft instead of remounting, to avoid same-tick chord races before the composer guard runs.
    if (commentPopoverRef.current) {
      return true
    }
    if (!shouldShowMarkdownAnnotationsRef.current) {
      return false
    }
    // Why: the rendered target ref lags selection by a render, so read Monaco's live selection to avoid opening on a stale one.
    const target = getMonacoMarkdownSelectionAnnotationTarget(
      editorInstance,
      editorInstance.getSelection(),
      getDiffCommentPopoverLeft(editorInstance, editorContainerRef.current) ?? undefined
    )
    if (!target) {
      return false
    }
    commentPopoverRef.current = target
    setCommentPopover(target)
    setSelectionAnnotationTarget(null)
    return true
  })
  const searchInFilesAction = editorInstance.addAction({
    id: 'orca.searchInFiles',
    label: translate('auto.components.editor.MonacoEditor.fd68ae03b3', 'Search in Files'),
    contextMenuGroupId: 'navigation',
    contextMenuOrder: 2,
    run: () => {
      if (!worktreeId) {
        return
      }
      const query = getMonacoCodebaseSearchQuery(
        editorInstance.getModel(),
        editorInstance.getSelection(),
        editorInstance.getPosition()
      )
      if (!query) {
        return
      }
      const state = useAppStore.getState()
      state.showRightSidebarSearch({ query })
    }
  })
  const onLargeTextPaste = (event: ClipboardEvent): void => {
    handleMonacoLargeTextPaste(editorInstance, event, {
      readOnly: readOnlyRef.current,
      onPasteStart: () => {
        isApplyingLargePasteRef.current = true
      },
      onPasteResult: (result) => {
        isApplyingLargePasteRef.current = false
        if (result.status === 'pasted' || result.status === 'cancelled') {
          const value = editorInstance.getValue()
          lastSyncedContentRef.current = value
          propsRef.current.onContentChange(value)
        }
        if (result.status === 'rejected' && result.reason === 'too-large') {
          toast.error(
            translate(
              'auto.components.editor.MonacoEditor.largePasteTooLarge',
              'Paste is too large.'
            )
          )
        }
      }
    })
  }
  editorDomNode.addEventListener('paste', onLargeTextPaste, { capture: true })

  return {
    disposeInputBindings: () => {
      cleanupSaveShortcut()
      cleanupFindShortcut()
      cleanupCommandPaletteShortcut()
      cleanupAddReviewNoteShortcut()
      editorDomNode.removeEventListener('paste', onLargeTextPaste, { capture: true })
      searchInFilesAction.dispose()
    }
  }
}
