import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type { editor } from 'monaco-editor'
import type { useContextualCopySetup } from './useContextualCopySetup'
import type { MonacoContentSyncMode } from './monaco-content-sync'
import type { MarkdownDocLinkDecorationController } from './monaco-markdown-doc-link-decorations'
import type { MonacoMarkdownSelectionAnnotationTarget } from './monaco-markdown-selection-annotation'
import type { MarkdownCommentPopoverState } from './use-monaco-markdown-annotations'

export type MonacoEditorPropsRef = MutableRefObject<{
  relativePath: string
  language: string
  onSave: (content: string) => void
  onContentChange: (content: string) => void
}>

export type MonacoEditorMountParams = {
  fileId: string
  filePath: string
  viewStateKey: string
  viewStateId: string | undefined
  worktreeId: string | undefined
  autoHeight: boolean
  autoHeightLineHeight: number
  editorRef: MutableRefObject<editor.IStandaloneCodeEditor | null>
  editorContainerRef: MutableRefObject<HTMLDivElement | null>
  languageRef: MutableRefObject<string>
  propsRef: MonacoEditorPropsRef
  readOnlyRef: MutableRefObject<boolean>
  scrollThrottleTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>
  unregisterFileSearchSelectionRef: MutableRefObject<(() => void) | null>
  setMountedEditor: Dispatch<SetStateAction<editor.IStandaloneCodeEditor | null>>
  setAutoHeightContentHeight: Dispatch<SetStateAction<number | null>>
  setEditorCursorLine: (fileId: string, line: number) => void
  setupCopy: ReturnType<typeof useContextualCopySetup>['setupCopy']
  queueReveal: (
    editorInstance: editor.IStandaloneCodeEditor,
    line: number,
    column: number,
    matchLength: number,
    onApplied?: () => void
  ) => void
  contentSync: {
    contentRef: MutableRefObject<string>
    lastSyncedContentRef: MutableRefObject<string>
    contentSyncModeRef: MutableRefObject<MonacoContentSyncMode>
    isApplyingProgrammaticContentRef: MutableRefObject<boolean>
    isApplyingLargePasteRef: MutableRefObject<boolean>
  }
  decorations: {
    markdownDocLinkDecorationsRef: MutableRefObject<MarkdownDocLinkDecorationController | null>
    conflictDecorationsRef: MutableRefObject<editor.IEditorDecorationsCollection | null>
    updateMarkdownCompletionDocuments: () => void
  }
  annotations: {
    commentPopoverRef: MutableRefObject<MarkdownCommentPopoverState | null>
    shouldShowMarkdownAnnotationsRef: MutableRefObject<boolean>
    setCommentPopover: Dispatch<SetStateAction<MarkdownCommentPopoverState | null>>
    setSelectionAnnotationTarget: Dispatch<
      SetStateAction<MonacoMarkdownSelectionAnnotationTarget | null>
    >
  }
  gutterMenu: {
    setGutterMenuOpen: Dispatch<SetStateAction<boolean>>
    setGutterMenuPoint: Dispatch<SetStateAction<{ x: number; y: number }>>
    setGutterMenuLine: Dispatch<SetStateAction<number>>
  }
}
