import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { DiffEditor, type DiffOnMount } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import { useAppStore } from '@/store'
import { diffViewStateCache, setWithLRU } from '@/lib/scroll-cache'
import { computeDiffEditorFontSize } from '@/lib/editor-font-zoom'
import { useContextualCopySetup } from './useContextualCopySetup'
import { selectWorktreeDiffComments } from '@/store/worktree-diff-comments-selector'
import { DiffCommentPopover } from '../diff-comments/DiffCommentPopover'
import { applyDiffEditorLineNumberOptions } from './diff-editor-line-number-options'
import {
  isDiffComment,
  prCommentsToDecoratedDiffComments,
  selectRawPRCommentsFromStore
} from '@/lib/diff-comment-compat'
import { installEditorSaveShortcut, installMonacoEditorFindShortcut } from './editor-shortcuts'
import { diffEditorScrollbarOptions } from './diff-editor-scrollbar-options'
import { LargeDiffFallback } from './LargeDiffFallback'
import { getLargeDiffRenderLimit } from './large-diff-render-limit'
import { useDiffViewerLargeDiffLifecycle } from './useDiffViewerLargeDiffLifecycle'
import { getDiffViewerLargeDiffSaveAction } from './diff-viewer-large-diff-save-action'
import type { DiffViewerProps } from './diff-viewer-props'
import { buildDiffEditorWordWrapOptions } from './diff-editor-word-wrap-options'
import { useDiffEditorRegistration } from './diff-navigation-context'
import { useDiffCommentSubmit } from './useDiffCommentSubmit'
import { useDiffCommentPopoverPosition } from './useDiffCommentPopoverPosition'
import { useDiffCommentDecoratorConfig } from './useDiffCommentDecoratorConfig'
import { useDiffViewerAutoScroll } from './useDiffViewerAutoScroll'

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
  const fetchPRComments = useAppStore((s) => s.fetchPRComments)
  const fetchPRForBranch = useAppStore((s) => s.fetchPRForBranch)

  const worktree = useAppStore((s) => (worktreeId ? s.getKnownWorktreeById(worktreeId) : undefined))
  const wtPath = worktree?.path
  const wtBranch = worktree?.branch
  const wtLinkedPR = worktree?.linkedPR
  const wtRepoId = worktree?.repoId

  // Why: fetch PR comments in the background when the diff viewer mounts.
  // The dev server restart clears the transient in-memory commentsCache; fetching on
  // mount ensures review comments are available in the editor even if the right-sidebar
  // ChecksPanel was never opened in this session.
  useEffect(() => {
    if (!wtPath) {
      return
    }
    const load = async () => {
      try {
        let pr = wtLinkedPR
        if (!pr && wtBranch) {
          const prInfo = await fetchPRForBranch(wtPath, wtBranch, { repoId: wtRepoId })
          if (prInfo) {
            pr = prInfo.number
          }
        }
        if (pr) {
          void fetchPRComments(wtPath, pr, { repoId: wtRepoId })
        }
      } catch {
        // best-effort background warm-up; ignore failures
      }
    }
    void load()
  }, [wtPath, wtBranch, wtLinkedPR, wtRepoId, fetchPRComments, fetchPRForBranch])

  // Why: split local and PR comment subscriptions into separate selectors so
  // each returns a stable store reference. Combining them inside a single
  // useAppStore selector caused a new array on every store update (via .filter
  // and spread), triggering infinite re-renders.
  const localDiffComments = useAppStore((s) => selectWorktreeDiffComments(s, worktreeId))
  const rawPRComments = useAppStore((s) => selectRawPRCommentsFromStore(s, worktreeId))
  const allComments = useMemo(() => {
    const local = (localDiffComments ?? []).filter(
      (c) => c.filePath === relativePath && isDiffComment(c)
    )
    const pr = prCommentsToDecoratedDiffComments(rawPRComments, relativePath, worktreeId ?? '')
    return [...local, ...pr]
  }, [localDiffComments, rawPRComments, relativePath, worktreeId])
  const diffEditorFontSize = computeDiffEditorFontSize(
    settings?.terminalFontSize ?? 13,
    editorFontZoomLevel
  )
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

  // Why: only forward the pending scroll id when this viewer owns the matching
  // comment (worktree+path). Otherwise unrelated viewers would also try to
  // scroll and ack the request first, racing the intended viewer.
  const pendingScrollForThisViewer = useMemo(() => {
    if (!worktreeId || !scrollToDiffCommentId) {
      return null
    }
    // Why: match scroll requests by either full ID, pr-prefixed ID, or raw ID from github-pr-comment prefix.
    const targetComment = allComments.find(
      (c) =>
        c.id === scrollToDiffCommentId ||
        c.id === `pr-${scrollToDiffCommentId}` ||
        (scrollToDiffCommentId.startsWith('github-pr-comment:') &&
          c.id === `pr-${scrollToDiffCommentId.substring('github-pr-comment:'.length)}`)
    )
    return targetComment ? targetComment.id : null
  }, [scrollToDiffCommentId, allComments, worktreeId])

  useDiffCommentDecoratorConfig({
    hasLineCommentAction,
    modifiedEditor,
    relativePath,
    worktreeId,
    allComments,
    commentableLineNumbers,
    addLineCommentLabel,
    deleteDiffComment,
    updateDiffComment,
    pendingScrollForThisViewer,
    setScrollToDiffCommentId,
    diffBodyRef,
    setPopover
  })

  useDiffCommentPopoverPosition({
    modifiedEditor,
    popover,
    diffBodyRef,
    setPopover
  })

  // Why: on a fresh open (no cached view state, no pending scroll-to-note),
  // center the first diff change in the viewport. We do this from a dedicated
  // effect — not from handleMount — so it sequences AFTER the comment
  // decorator inserts its view zones. If we scrolled during handleMount, late
  // zone insertion would shift content downward and the user would land on a
  // note further down the file instead of the first change.
  //
  // `getTopForLineNumber(line, /* includeViewZones */ true)` accounts for any
  // zones already in the layout, so the math survives whatever the decorator
  // added in this render pass. The didScroll guard makes this strictly
  // one-shot per mount.
  useDiffViewerAutoScroll({
    diffEditorRef,
    modifiedEditor,
    modelKey,
    pendingScrollForThisViewer
  })

  const handleEnterLargeDiffFallback = useCallback(() => {
    // Why: when a tab transitions to the safety fallback, stale Monaco refs
    // must not keep comment decorators or save handlers talking to disposed UI.
    lineNumberOptionsSubRef.current?.dispose()
    lineNumberOptionsSubRef.current = null
    // Why: capture before nulling so we unregister the exact instance the
    // navigator may still hold (identity guard no-ops a stale dispose).
    const fallenBackEditor = diffEditorRef.current
    diffEditorRef.current = null
    if (fallenBackEditor) {
      unregisterDiffEditor(fallenBackEditor)
    }
    setModifiedEditor(null)
    setPopover(null)
  }, [unregisterDiffEditor])

  const handleSubmitComment = useDiffCommentSubmit({
    popover,
    onAddLineComment,
    worktreeId,
    relativePath,
    addDiffComment,
    setPopover
  })

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

      setupCopy(originalEditor, monaco, filePath, propsRef)
      setupCopy(modifiedEditor, monaco, filePath, propsRef)
      setModifiedEditor(modifiedEditor)

      // Why: restoring the full diff view state matches VS Code more closely
      // than replaying scrollTop alone, and avoids divergent cursor/selection
      // state between the original and modified panes.
      const savedViewState = diffViewStateCache.get(modelKey)
      if (savedViewState) {
        requestAnimationFrame(() => diffEditor.restoreViewState(savedViewState))
      }
      // Auto-scroll to first diff is handled in a separate useEffect below so
      // it can sequence after the comment-decorator inserts its view zones —
      // otherwise late zones shift content downward and the user lands away
      // from the first change (e.g. on a note further down the file).

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
          // Why: editable diff views own both panes' shortcut bridges and the
          // model subscription for the lifetime of this Monaco diff instance.
          cleanupSaveShortcut()
          cleanupOriginalFindShortcut()
          cleanupModifiedFindShortcut()
          modelContentSub.dispose()
        })

        modifiedEditor.focus()
      } else {
        diffEditor.focus()
      }

      // Why: clear modifiedEditor on dispose so decorator effects (scroll-to-note,
      // popover position) don't invoke methods on a disposed Monaco editor.
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

  // Why: VS Code snapshots diff view state on deactivation, not on scroll events.
  // The useLayoutEffect cleanup fires synchronously before React unmounts the
  // component on tab switch, which is Orca's equivalent of VS Code's clearInput().
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
            // Why: A single file can have multiple live diff tabs at once
            // (staged, unstaged, branch compare versions). The kept Monaco models
            // must therefore key off the tab identity, not the raw file path, or
            // one diff tab can incorrectly reuse another tab's model contents.
            // Why: Changes mode sometimes needs to rotate only the original-side
            // model after HEAD moves, while preserving the modified-side model's
            // undo stack for continued editing.
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
