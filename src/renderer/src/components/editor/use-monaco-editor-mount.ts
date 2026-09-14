import { useCallback } from 'react'
import type { OnMount } from '@monaco-editor/react'
import { useAppStore } from '@/store'
import { registerFileSearchSelectedTextProvider } from '@/lib/file-search-selection'
import { syncContentOnMount } from './monaco-content-sync'
import {
  beginProgrammaticContentSync,
  endProgrammaticContentSync
} from './monaco-programmatic-sync'
import { createMarkdownDocLinkDecorationController } from './monaco-markdown-doc-link-decorations'
import { ensureMarkdownDocCompletionProvider } from './monaco-markdown-doc-completions'
import { clampMonacoAutoHeight } from './monaco-auto-height'
import { installMonacoE2EProbe } from './monaco-e2e-probe'
import { matchesPendingEditorFocusRequest } from './pending-editor-focus-request'
import { installMonacoEditorInputBindings } from './monaco-editor-input-bindings'
import type { MonacoEditorMountParams } from './monaco-editor-mount-params'
import {
  installMonacoViewStateTracking,
  restoreMonacoViewState
} from './monaco-view-state-persistence'

// Why: binds a freshly created Monaco instance to the app; reads everything through refs so the callback identity stays stable across renders.
export function useMonacoEditorMount(params: MonacoEditorMountParams): OnMount {
  const {
    fileId,
    filePath,
    viewStateKey,
    viewStateId,
    worktreeId,
    autoHeight,
    autoHeightLineHeight,
    editorRef,
    editorContainerRef,
    languageRef,
    propsRef,
    readOnlyRef,
    scrollThrottleTimerRef,
    unregisterFileSearchSelectionRef,
    setMountedEditor,
    setAutoHeightContentHeight,
    setEditorCursorLine,
    setupCopy,
    queueReveal,
    contentSync: {
      contentRef,
      lastSyncedContentRef,
      contentSyncModeRef,
      isApplyingProgrammaticContentRef,
      isApplyingLargePasteRef
    },
    decorations: {
      markdownDocLinkDecorationsRef,
      conflictDecorationsRef,
      updateMarkdownCompletionDocuments
    },
    annotations: {
      commentPopoverRef,
      shouldShowMarkdownAnnotationsRef,
      setCommentPopover,
      setSelectionAnnotationTarget
    },
    gutterMenu: { setGutterMenuOpen, setGutterMenuPoint, setGutterMenuLine }
  } = params

  return useCallback<OnMount>(
    (editorInstance, monaco) => {
      editorRef.current = editorInstance
      setMountedEditor(editorInstance)
      const uninstallE2EProbe = installMonacoE2EProbe(editorInstance, filePath)
      let autoHeightSub: { dispose: () => void } | null = null
      let autoHeightFrame: number | null = null
      const updateAutoHeight = (): void => {
        if (!autoHeight) {
          return
        }
        if (autoHeightFrame !== null) {
          return
        }
        autoHeightFrame = window.requestAnimationFrame(() => {
          autoHeightFrame = null
          setAutoHeightContentHeight(
            clampMonacoAutoHeight(
              Math.ceil(editorInstance.getContentHeight()) + 1,
              autoHeightLineHeight
            )
          )
        })
      }
      if (autoHeight) {
        updateAutoHeight()
        autoHeightSub = editorInstance.onDidContentSizeChange(updateAutoHeight)
      }
      markdownDocLinkDecorationsRef.current = createMarkdownDocLinkDecorationController(
        editorInstance,
        () => languageRef.current
      )
      ensureMarkdownDocCompletionProvider(monaco)
      updateMarkdownCompletionDocuments()

      // Why: see contentRef — reconcile the retained model to the current prop before user interaction (surfaces edits made while unmounted).
      beginProgrammaticContentSync(filePath)
      isApplyingProgrammaticContentRef.current = true
      try {
        const didSyncOnMount = syncContentOnMount(
          editorInstance,
          contentRef.current,
          contentSyncModeRef.current
        )
        if (didSyncOnMount) {
          lastSyncedContentRef.current = contentRef.current
        }
      } finally {
        isApplyingProgrammaticContentRef.current = false
        endProgrammaticContentSync(filePath)
      }

      setupCopy(editorInstance, monaco, filePath, propsRef)
      unregisterFileSearchSelectionRef.current?.()
      unregisterFileSearchSelectionRef.current = registerFileSearchSelectedTextProvider(() => {
        if (!editorInstance.hasTextFocus()) {
          return null
        }
        const model = editorInstance.getModel()
        const selection = editorInstance.getSelection()
        if (!model || !selection || selection.isEmpty()) {
          return null
        }
        // Why: Monaco selections live in its text model, not the DOM selection API that app shortcuts read.
        return model.getValueInRange(selection)
      })

      const { disposeInputBindings } = installMonacoEditorInputBindings({
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
      })

      const { cursorPositionSub, scrollStateSub } = installMonacoViewStateTracking({
        editorInstance,
        filePath,
        viewStateKey,
        scrollThrottleTimerRef,
        setEditorCursorLine
      })

      // Why: custom Radix gutter menu instead of Monaco's built-in right-click menu (VSCode approach).
      const gutterMouseDownSub = editorInstance.onMouseDown((e) => {
        if (
          e.event.rightButton &&
          e.target.type === monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS
        ) {
          e.event.preventDefault()
          e.event.stopPropagation()
          const line = e.target.position?.lineNumber ?? 1
          editorInstance.setPosition({ lineNumber: line, column: 1 })
          setGutterMenuLine(line)
          setGutterMenuPoint({ x: e.event.posx, y: e.event.posy })
          setGutterMenuOpen(true)
        }
      })

      editorInstance.onDidDispose(() => {
        cursorPositionSub.dispose()
        scrollStateSub.dispose()
        gutterMouseDownSub.dispose()
        disposeInputBindings()
        autoHeightSub?.dispose()
        if (autoHeightFrame !== null) {
          window.cancelAnimationFrame(autoHeightFrame)
          autoHeightFrame = null
        }
        conflictDecorationsRef.current?.clear()
        conflictDecorationsRef.current = null
        uninstallE2EProbe()
        editorRef.current = null
        setMountedEditor(null)
        setCommentPopover(null)
      })

      // If there's a pending reveal at mount time, execute it now
      const reveal = useAppStore.getState().pendingEditorReveal
      // Why: scope reveal consumption to the destination file, or the previously mounted editor clears it before openFile switches tabs.
      const revealMatchesEditor = reveal?.fileId
        ? reveal.fileId === fileId
        : reveal?.filePath === filePath
      if (reveal && revealMatchesEditor) {
        queueReveal(editorInstance, reveal.line, reveal.column, reveal.matchLength, () => {
          useAppStore.getState().setPendingEditorReveal(null)
        })
      } else {
        restoreMonacoViewState(editorInstance, viewStateKey)
      }

      // Why: every mount path above focuses, so an explicit open handoff is already satisfied here.
      // Retiring it stops a later rich-mode remount of this same pane from stealing focus back.
      const focusRequest = useAppStore.getState().pendingEditorFocusRequest
      if (
        focusRequest &&
        matchesPendingEditorFocusRequest(focusRequest, { fileId, worktreeId, viewStateId })
      ) {
        useAppStore.getState().consumeEditorFocusRequest(focusRequest.token)
      }
    },
    [
      queueReveal,
      setupCopy,
      fileId,
      filePath,
      setEditorCursorLine,
      updateMarkdownCompletionDocuments,
      viewStateKey,
      viewStateId,
      autoHeight,
      autoHeightLineHeight,
      worktreeId,
      editorRef,
      editorContainerRef,
      languageRef,
      propsRef,
      readOnlyRef,
      scrollThrottleTimerRef,
      unregisterFileSearchSelectionRef,
      setMountedEditor,
      setAutoHeightContentHeight,
      contentRef,
      lastSyncedContentRef,
      contentSyncModeRef,
      isApplyingProgrammaticContentRef,
      isApplyingLargePasteRef,
      markdownDocLinkDecorationsRef,
      conflictDecorationsRef,
      commentPopoverRef,
      shouldShowMarkdownAnnotationsRef,
      setCommentPopover,
      setSelectionAnnotationTarget,
      setGutterMenuOpen,
      setGutterMenuPoint,
      setGutterMenuLine
    ]
  )
}
