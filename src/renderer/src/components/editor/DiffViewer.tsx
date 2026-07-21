import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { DiffEditor, type DiffOnMount } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import { useAppStore } from '@/store'
import { diffViewStateCache, setWithLRU } from '@/lib/scroll-cache'
import { monaco } from '@/lib/monaco-setup'
import { computeDiffEditorFontSize } from '@/lib/editor-font-zoom'
import { useContextualCopySetup } from './useContextualCopySetup'
import { selectWorktreeDiffComments } from '@/store/worktree-diff-comments-selector'
import { useDiffCommentDecorator } from '../diff-comments/useDiffCommentDecorator'
import { DiffCommentPopover } from '../diff-comments/DiffCommentPopover'
import {
  getDiffCommentPopoverLeft,
  getDiffCommentPopoverTop
} from '../diff-comments/diff-comment-popover-position'
import { applyDiffEditorLineNumberOptions } from './diff-editor-line-number-options'
import type { DiffComment } from '../../../../shared/types'
import { isDiffComment } from '@/lib/diff-comment-compat'
import { installEditorSaveShortcut, installMonacoEditorFindShortcut } from './editor-shortcuts'
import { diffEditorScrollbarOptions } from './diff-editor-scrollbar-options'
import { LargeDiffFallback } from './LargeDiffFallback'
import { getLargeDiffRenderLimit } from './large-diff-render-limit'
import { useDiffViewerLargeDiffLifecycle } from './useDiffViewerLargeDiffLifecycle'
import { getDiffViewerLargeDiffSaveAction } from './diff-viewer-large-diff-save-action'
import type { DiffViewerProps } from './diff-viewer-props'
import { buildDiffEditorWordWrapOptions } from './diff-editor-word-wrap-options'
import { useDiffEditorRegistration } from './diff-navigation-context'
import { preserveDiffViewStateAcrossModelSwaps } from './diff-model-swap-view-state'

export default function DiffViewer({
  modelKey,
  originalModelKey,
  modifiedModelKey,
  originalContent,
  modifiedContent,
  language,
  filePath,
  relativePath,
  sideBySide,
  editable,
  worktreeId,
  onAddLineComment,
  commentableLineNumbers,
  addLineCommentLabel,
  addLineCommentPlaceholder,
  onContentChange,
  onSave,
  largeDiffRenderLimit,
  largeDiffSaveContentAvailable
}: DiffViewerProps): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const editorFontZoomLevel = useAppStore((s) => s.editorFontZoomLevel)
  const addDiffComment = useAppStore((s) => s.addDiffComment)
  const deleteDiffComment = useAppStore((s) => s.deleteDiffComment)
  const updateDiffComment = useAppStore((s) => s.updateDiffComment)
  const scrollToDiffCommentId = useAppStore((s) => s.scrollToDiffCommentId)
  const setScrollToDiffCommentId = useAppStore((s) => s.setScrollToDiffCommentId)
  // Why: subscribe to the raw array so selector identity only changes when this worktree's comments change; filtering happens below.
  const allDiffComments = useAppStore((s): DiffComment[] | undefined =>
    selectWorktreeDiffComments(s, worktreeId)
  )
  const diffComments = useMemo(
    () => (allDiffComments ?? []).filter((c) => c.filePath === relativePath && isDiffComment(c)),
    [allDiffComments, relativePath]
  )
  const terminalFontSize = settings?.terminalFontSize ?? 13
  const diffEditorFontSize = computeDiffEditorFontSize(terminalFontSize, editorFontZoomLevel)
  const isDark =
    settings?.theme === 'dark' ||
    (settings?.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)

  const diffEditorRef = useRef<editor.IStandaloneDiffEditor | null>(null)
  const { registerDiffEditor, unregisterDiffEditor } = useDiffEditorRegistration()
  const diffBodyRef = useRef<HTMLDivElement | null>(null)
  const lineNumberOptionsSubRef = useRef<{ dispose: () => void } | null>(null)
  const [modifiedEditor, setModifiedEditor] = useState<editor.ICodeEditor | null>(null)
  const [popover, setPopover] = useState<{
    lineNumber: number
    startLine?: number
    top: number
    left?: number
    lineHeight: number
  } | null>(null)

  const renderLimit = useMemo(
    () => largeDiffRenderLimit ?? getLargeDiffRenderLimit({ originalContent, modifiedContent }),
    [largeDiffRenderLimit, originalContent, modifiedContent]
  )
  const hasLineCommentAction = Boolean(worktreeId || onAddLineComment)

  // Why: only forward the pending scroll id when this viewer owns the comment, else unrelated viewers race to ack it.
  const pendingScrollForThisViewer = useMemo(() => {
    if (!worktreeId || !scrollToDiffCommentId) {
      return null
    }
    return diffComments.some((c) => c.id === scrollToDiffCommentId) ? scrollToDiffCommentId : null
  }, [scrollToDiffCommentId, diffComments, worktreeId])

  // Why: gate the decorator on a comment target; updateDiffComment is only wired for local diffs (worktreeId present).
  useDiffCommentDecorator({
    editor: hasLineCommentAction ? modifiedEditor : null,
    monacoModelIdentity: modifiedModelKey ?? modelKey,
    filePath: relativePath,
    worktreeId: worktreeId ?? '',
    comments: worktreeId ? diffComments : [],
    commentableLineNumbers,
    addButtonLabel: addLineCommentLabel,
    onAddCommentClick: ({ lineNumber, startLine, top }) =>
      setPopover({
        lineNumber,
        startLine,
        top,
        left: modifiedEditor
          ? (getDiffCommentPopoverLeft(modifiedEditor, diffBodyRef.current) ?? undefined)
          : undefined,
        lineHeight: modifiedEditor?.getOption(monaco.editor.EditorOption.lineHeight) ?? 0
      }),
    onDeleteComment: (id) => {
      if (worktreeId) {
        void deleteDiffComment(worktreeId, id)
      }
    },
    onUpdateComment: worktreeId ? (id, body) => updateDiffComment(worktreeId, id, body) : undefined,
    pendingScrollCommentId: pendingScrollForThisViewer,
    onPendingScrollConsumed: () => setScrollToDiffCommentId(null)
  })

  useEffect(() => {
    if (!modifiedEditor || !popover) {
      return
    }
    const update = (): void => {
      const lineHeight = modifiedEditor.getOption(monaco.editor.EditorOption.lineHeight)
      const top = getDiffCommentPopoverTop(modifiedEditor, popover.lineNumber, lineHeight)
      if (top == null) {
        setPopover(null)
        return
      }
      const left = getDiffCommentPopoverLeft(modifiedEditor, diffBodyRef.current)
      setPopover((prev) =>
        prev ? { ...prev, top, left: left == null ? prev.left : left, lineHeight } : prev
      )
    }
    const scrollSub = modifiedEditor.onDidScrollChange(update)
    const contentSub = modifiedEditor.onDidContentSizeChange(update)
    const layoutSub = modifiedEditor.onDidLayoutChange(update)
    return () => {
      scrollSub.dispose()
      contentSub.dispose()
      layoutSub.dispose()
    }
    // Why: depend on popover.lineNumber (not the whole object) so the effect doesn't re-subscribe on every top update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modifiedEditor, popover?.lineNumber])

  // Why: center the first diff from a dedicated effect (not handleMount) so it runs after the decorator's view zones, which would otherwise shift content downward.
  const didAutoScrollFirstDiffRef = useRef(false)
  const didAutoScrollModelKeyRef = useRef(modelKey)
  useEffect(() => {
    if (didAutoScrollModelKeyRef.current !== modelKey) {
      didAutoScrollModelKeyRef.current = modelKey
      // Why: reset the per-modelKey one-shot here before the first-diff guard runs for the new file.
      didAutoScrollFirstDiffRef.current = false
    }
    const diffEditor = diffEditorRef.current
    if (!diffEditor || !modifiedEditor) {
      return
    }
    if (didAutoScrollFirstDiffRef.current) {
      return
    }
    if (diffViewStateCache.get(modelKey)) {
      return
    }
    if (pendingScrollForThisViewer) {
      // Why: decorator owns this scroll, so set the one-shot flag; else we'd re-run and overwrite it when pendingScroll flips back to null.
      didAutoScrollFirstDiffRef.current = true
      return
    }
    let rafId: number | null = null
    const run = (): void => {
      if (didAutoScrollFirstDiffRef.current) {
        return
      }
      const changes = diffEditor.getLineChanges()
      if (!changes || changes.length === 0) {
        return
      }
      const line = Math.max(1, changes[0].modifiedStartLineNumber)
      // Defer one frame so view zones are laid out before measuring; cancel any earlier rAF to avoid a redundant scroll.
      if (rafId !== null) {
        cancelAnimationFrame(rafId)
      }
      rafId = requestAnimationFrame(() => {
        rafId = null
        if (didAutoScrollFirstDiffRef.current || !modifiedEditor.getModel()) {
          return
        }
        const top = modifiedEditor.getTopForLineNumber(line, true)
        const editorHeight = modifiedEditor.getLayoutInfo().height
        modifiedEditor.setPosition({ lineNumber: line, column: 1 })
        modifiedEditor.setScrollTop(Math.max(0, top - editorHeight / 2))
        didAutoScrollFirstDiffRef.current = true
      })
    }
    // Run now if the diff is ready; otherwise onDidUpdateDiff fires once the computation lands.
    if (diffEditor.getLineChanges()) {
      run()
    }
    const sub = diffEditor.onDidUpdateDiff(() => run())
    return () => {
      sub.dispose()
      if (rafId !== null) {
        cancelAnimationFrame(rafId)
      }
    }
  }, [modifiedEditor, modelKey, pendingScrollForThisViewer])

  const handleEnterLargeDiffFallback = useCallback(() => {
    // Why: on fallback transition, drop stale Monaco refs so decorators/save handlers don't talk to disposed UI.
    lineNumberOptionsSubRef.current?.dispose()
    lineNumberOptionsSubRef.current = null
    // Why: capture before nulling so we unregister the exact instance (identity guard no-ops a stale dispose).
    const fallenBackEditor = diffEditorRef.current
    diffEditorRef.current = null
    if (fallenBackEditor) {
      unregisterDiffEditor(fallenBackEditor)
    }
    setModifiedEditor(null)
    setPopover(null)
  }, [unregisterDiffEditor])

  const handleSubmitComment = async (body: string): Promise<void> => {
    if (!popover) {
      return
    }
    if (onAddLineComment) {
      const ok = await onAddLineComment({
        lineNumber: popover.lineNumber,
        startLine: popover.startLine,
        body
      })
      if (ok) {
        setPopover(null)
      }
      return
    }
    if (!worktreeId) {
      return
    }
    // Why: await persistence — a null result (failed save) keeps the popover open for retry instead of losing the draft.
    const result = await addDiffComment({
      worktreeId,
      filePath: relativePath,
      source: 'diff',
      startLine: popover.startLine,
      lineNumber: popover.lineNumber,
      body,
      side: 'modified'
    })
    if (result) {
      setPopover(null)
    } else {
      console.error('Failed to add diff comment — draft preserved')
    }
  }

  // Keep refs to latest callbacks so the mounted editor always calls current versions
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave
  const onContentChangeRef = useRef(onContentChange)
  onContentChangeRef.current = onContentChange

  const { setupCopy, toastNode } = useContextualCopySetup()

  const propsRef = useRef({ relativePath, language, onSave })
  propsRef.current = { relativePath, language, onSave }
  const currentDiffModelPaths = useDiffViewerLargeDiffLifecycle({
    limited: renderLimit.limited,
    modelKey,
    originalModelKey,
    modifiedModelKey,
    diffEditorRef,
    onEnterFallback: handleEnterLargeDiffFallback
  })

  const handleMount: DiffOnMount = useCallback(
    (diffEditor, monaco) => {
      diffEditorRef.current = diffEditor
      registerDiffEditor(diffEditor)
      lineNumberOptionsSubRef.current?.dispose()
      lineNumberOptionsSubRef.current = applyDiffEditorLineNumberOptions(diffEditor, sideBySide)

      const originalEditor = diffEditor.getOriginalEditor()
      const modifiedEditor = diffEditor.getModifiedEditor()
      diffEditor.onDidDispose(preserveDiffViewStateAcrossModelSwaps(diffEditor).dispose)

      setupCopy(originalEditor, monaco, filePath, propsRef)
      setupCopy(modifiedEditor, monaco, filePath, propsRef)
      setModifiedEditor(modifiedEditor)

      // Why: restore full diff view state (not just scrollTop) so cursor/selection stay consistent across both panes.
      const savedViewState = diffViewStateCache.get(modelKey)
      if (savedViewState) {
        requestAnimationFrame(() => diffEditor.restoreViewState(savedViewState))
      }
      // Auto-scroll to first diff lives in a separate effect below so it sequences after the decorator's view zones land.

      if (editable) {
        const cleanupSaveShortcut = installEditorSaveShortcut(
          modifiedEditor.getContainerDomNode(),
          () => {
            onSaveRef.current?.(modifiedEditor.getValue())
          }
        )
        const cleanupOriginalFindShortcut = installMonacoEditorFindShortcut(originalEditor)
        const cleanupModifiedFindShortcut = installMonacoEditorFindShortcut(modifiedEditor)

        // Track changes
        const modelContentSub = modifiedEditor.onDidChangeModelContent(() => {
          onContentChangeRef.current?.(modifiedEditor.getValue())
        })
        modifiedEditor.onDidDispose(() => {
          // Why: this diff instance owns both panes' shortcut bridges + the model sub, so dispose them with it.
          cleanupSaveShortcut()
          cleanupOriginalFindShortcut()
          cleanupModifiedFindShortcut()
          modelContentSub.dispose()
        })

        modifiedEditor.focus()
      } else {
        diffEditor.focus()
      }

      // Why: clear modifiedEditor on dispose so decorator effects don't call into a disposed Monaco editor.
      diffEditor.onDidDispose(() => {
        lineNumberOptionsSubRef.current?.dispose()
        lineNumberOptionsSubRef.current = null
        diffEditorRef.current = null
        unregisterDiffEditor(diffEditor)
        setModifiedEditor(null)
        setPopover(null)
      })
    },
    [editable, setupCopy, modelKey, filePath, sideBySide, registerDiffEditor, unregisterDiffEditor]
  )

  // Why: snapshot view state on deactivation (layoutEffect cleanup fires before unmount), not on scroll.
  useLayoutEffect(() => {
    return () => {
      const de = diffEditorRef.current
      if (de) {
        const currentViewState = de.saveViewState()
        if (currentViewState) {
          setWithLRU(diffViewStateCache, modelKey, currentViewState)
        }
      }
    }
  }, [modelKey])

  useEffect(() => {
    const diffEditor = diffEditorRef.current
    if (!diffEditor) {
      return
    }
    lineNumberOptionsSubRef.current?.dispose()
    lineNumberOptionsSubRef.current = applyDiffEditorLineNumberOptions(diffEditor, sideBySide)
    return () => {
      lineNumberOptionsSubRef.current?.dispose()
      lineNumberOptionsSubRef.current = null
    }
  }, [sideBySide])

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div ref={diffBodyRef} className="flex-1 min-h-0 relative">
        {popover && hasLineCommentAction && !renderLimit.limited && (
          <DiffCommentPopover
            key={popover.lineNumber}
            lineNumber={popover.lineNumber}
            startLine={popover.startLine}
            top={popover.top}
            left={popover.left}
            lineHeight={popover.lineHeight}
            placeholder={addLineCommentPlaceholder}
            submitLabel={addLineCommentLabel}
            submittingLabel="Posting…"
            onCancel={() => setPopover(null)}
            onSubmit={handleSubmitComment}
          />
        )}
        {renderLimit.limited ? (
          <LargeDiffFallback
            filePath={relativePath}
            renderLimit={renderLimit}
            action={getDiffViewerLargeDiffSaveAction({
              editable,
              modifiedContent,
              onSave,
              saveContentAvailable: largeDiffSaveContentAvailable
            })}
          />
        ) : (
          <DiffEditor
            height="100%"
            language={language}
            original={originalContent}
            modified={modifiedContent}
            theme={isDark ? 'vs-dark' : 'vs'}
            onMount={handleMount}
            // Why: a file can have multiple live diff tabs, so key models off tab identity (not file path) to avoid cross-tab reuse.
            // Why: Changes mode rotates only the original-side model after HEAD moves, preserving the modified side's undo stack.
            originalModelPath={currentDiffModelPaths.originalModelPath}
            modifiedModelPath={currentDiffModelPaths.modifiedModelPath}
            keepCurrentOriginalModel
            keepCurrentModifiedModel
            options={{
              readOnly: !editable,
              originalEditable: false,
              renderSideBySide: sideBySide,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              fontSize: diffEditorFontSize,
              fontFamily: settings?.terminalFontFamily || 'monospace',
              lineNumbers: 'on',
              ...buildDiffEditorWordWrapOptions(settings?.diffWordWrap),
              automaticLayout: true,
              renderOverviewRuler: true,
              scrollbar: diffEditorScrollbarOptions,
              padding: { top: 0 },
              find: {
                addExtraSpaceOnTop: false,
                autoFindInSelection: 'never',
                seedSearchStringFromSelection: 'never'
              }
            }}
          />
        )}
      </div>
      {toastNode}
    </div>
  )
}
