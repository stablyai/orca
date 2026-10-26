import { useCallback, useLayoutEffect, useRef } from 'react'
import type { OnMount } from '@monaco-editor/react'
import { useAppStore } from '@/store'
import { registerFileSearchSelectedTextProvider } from '@/lib/file-search-selection'
import { syncContentOnMount } from './monaco-content-sync'
import { toEditorModelUri } from './editor-model-uri'
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
import {
  isStaleCachedEditorText,
  mayPushTabTextIntoModel,
  requestStaleCacheReload,
  settleStaleCacheReload
} from './editor-stale-mount-guard'

function ignoreCursorLine(): void {}

// Read changing inputs through refs so retained Monaco listeners do not require remounts.
export function useMonacoEditorMount(params: MonacoEditorMountParams): OnMount {
  const {
    fileId,
    filePath,
    modelOwnerKey,
    viewStateKey,
    viewStateId,
    passiveMirror = false,
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
  // Why: retained listeners must follow committed ownership, never an abandoned render.
  const fileIdRef = useRef(fileId)
  useLayoutEffect(() => {
    fileIdRef.current = fileId
  }, [fileId])

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

      // Reconcile retained models before interaction so edits made while unmounted become visible.
      const modelKey = toEditorModelUri(filePath, modelOwnerKey)
      const staleCache = isStaleCachedEditorText(fileIdRef.current, contentRef.current)
      if (!staleCache) {
        settleStaleCacheReload(fileIdRef.current)
      }
      const liveTextDiffers = editorInstance.getModel()?.getValue() !== contentRef.current
      if (
        (staleCache && liveTextDiffers) ||
        (liveTextDiffers && !mayPushTabTextIntoModel(fileIdRef.current))
      ) {
        // Why: the live model's text is the truth; stale or disk text must never replace it.
        lastSyncedContentRef.current = contentRef.current
      } else if (staleCache) {
        // Why: no live model holds the truth, so drop the stale cache once to reload from disk.
        requestStaleCacheReload(fileIdRef.current, contentRef.current)
      } else {
        beginProgrammaticContentSync(modelKey)
        isApplyingProgrammaticContentRef.current = true
        try {
          if (syncContentOnMount(editorInstance, contentRef.current, contentSyncModeRef.current)) {
            lastSyncedContentRef.current = contentRef.current
          }
        } finally {
          isApplyingProgrammaticContentRef.current = false
          endProgrammaticContentSync(modelKey)
        }
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
        fileIdRef,
        viewStateKey,
        scrollThrottleTimerRef,
        setEditorCursorLine: passiveMirror ? ignoreCursorLine : setEditorCursorLine
      })

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

      const reveal = passiveMirror ? null : useAppStore.getState().pendingEditorReveal
      // Why: scope reveal consumption to the destination file, or the previously mounted editor clears it before openFile switches tabs.
      const revealMatchesEditor = reveal?.fileId
        ? reveal.fileId === fileId
        : reveal?.filePath === filePath
      if (
        reveal &&
        revealMatchesEditor &&
        (!reveal.viewStateId || reveal.viewStateId === viewStateId)
      ) {
        if (reveal.canApply?.() === false) {
          restoreMonacoViewState(editorInstance, viewStateKey, () => false)
          return
        }
        queueReveal(
          editorInstance,
          reveal.line,
          reveal.column,
          reveal.matchLength,
          () => {
            reveal.onApplied?.()
            if (useAppStore.getState().pendingEditorReveal === reveal) {
              useAppStore.getState().setPendingEditorReveal(null)
            }
          },
          reveal.canApply
            ? () =>
                useAppStore.getState().pendingEditorReveal === reveal &&
                reveal.canApply?.() !== false
            : undefined
        )
      } else {
        restoreMonacoViewState(
          editorInstance,
          viewStateKey,
          reveal?.viewStateId && revealMatchesEditor ? () => false : undefined
        )
      }

      // Retire satisfied open handoffs so later rich-mode remounts cannot steal focus back.
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
      modelOwnerKey,
      setEditorCursorLine,
      updateMarkdownCompletionDocuments,
      viewStateKey,
      viewStateId,
      passiveMirror,
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
