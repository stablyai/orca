import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { DiffEditor, type DiffOnMount } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import { useAppStore } from '@/store'
import { diffViewStateCache, setWithLRU } from '@/lib/scroll-cache'
import '@/lib/monaco-setup'
import { computeEditorFontSize } from '@/lib/editor-font-zoom'
import { useContextualCopySetup } from './useContextualCopySetup'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import { useDiffCommentDecorator } from '../diff-comments/useDiffCommentDecorator'
import { DiffCommentPopover } from '../diff-comments/DiffCommentPopover'
import { applyDiffEditorLineNumberOptions } from './diff-editor-line-number-options'
import type { DiffComment } from '../../../../shared/types'
import { isDiffComment } from '@/lib/diff-comment-compat'

type DiffViewerProps = {
  modelKey: string
  originalModelKey?: string
  modifiedModelKey?: string
  originalContent: string
  modifiedContent: string
  language: string
  filePath: string
  relativePath: string
  sideBySide: boolean
  editable?: boolean
  // Why: optional because DiffViewer is also used by GitHubItemDialog for PR
  // review, where there is no local worktree to attach comments to. When
  // omitted, the per-line comment decorator is skipped.
  worktreeId?: string
  onAddLineComment?: (args: {
    lineNumber: number
    startLine?: number
    body: string
  }) => Promise<boolean>
  addLineCommentLabel?: string
  addLineCommentPlaceholder?: string
  onContentChange?: (content: string) => void
  onSave?: (content: string) => void
}

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
  addLineCommentLabel,
  addLineCommentPlaceholder,
  onContentChange,
  onSave
}: DiffViewerProps): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const editorFontZoomLevel = useAppStore((s) => s.editorFontZoomLevel)
  const addDiffComment = useAppStore((s) => s.addDiffComment)
  const deleteDiffComment = useAppStore((s) => s.deleteDiffComment)
  const updateDiffComment = useAppStore((s) => s.updateDiffComment)
  const scrollToDiffCommentId = useAppStore((s) => s.scrollToDiffCommentId)
  const setScrollToDiffCommentId = useAppStore((s) => s.setScrollToDiffCommentId)
  // Why: subscribe to the raw comments array on the worktree so selector
  // identity only changes when diffComments actually changes on this worktree.
  // Filtering by relativePath happens in a memo below.
  const allDiffComments = useAppStore((s): DiffComment[] | undefined =>
    worktreeId ? findWorktreeById(s.worktreesByRepo, worktreeId)?.diffComments : undefined
  )
  const diffComments = useMemo(
    () => (allDiffComments ?? []).filter((c) => c.filePath === relativePath && isDiffComment(c)),
    [allDiffComments, relativePath]
  )
  const editorFontSize = computeEditorFontSize(
    settings?.terminalFontSize ?? 13,
    editorFontZoomLevel
  )
  const isDark =
    settings?.theme === 'dark' ||
    (settings?.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)

  const diffEditorRef = useRef<editor.IStandaloneDiffEditor | null>(null)
  const lineNumberOptionsSubRef = useRef<{ dispose: () => void } | null>(null)
  const [modifiedEditor, setModifiedEditor] = useState<editor.ICodeEditor | null>(null)
  const [popover, setPopover] = useState<{
    lineNumber: number
    startLine?: number
    top: number
  } | null>(null)

  const hasLineCommentAction = Boolean(worktreeId || onAddLineComment)

  // Why: only forward the pending scroll id when this viewer owns the matching
  // comment (worktree+path). Otherwise unrelated viewers would also try to
  // scroll and ack the request first, racing the intended viewer.
  const pendingScrollForThisViewer = useMemo(() => {
    if (!worktreeId || !scrollToDiffCommentId) {
      return null
    }
    return diffComments.some((c) => c.id === scrollToDiffCommentId) ? scrollToDiffCommentId : null
  }, [scrollToDiffCommentId, diffComments, worktreeId])

  // Why: gate the decorator on having a comment target. Local diffs persist
  // notes to worktree metadata; GitHub PR diffs post line comments remotely.
  // updateDiffComment is only wired for local diffs (worktreeId present).
  useDiffCommentDecorator({
    editor: hasLineCommentAction ? modifiedEditor : null,
    filePath: relativePath,
    worktreeId: worktreeId ?? '',
    comments: worktreeId ? diffComments : [],
    addButtonLabel: addLineCommentLabel,
    onAddCommentClick: ({ lineNumber, startLine, top }) =>
      setPopover({ lineNumber, startLine, top }),
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
      const top =
        modifiedEditor.getTopForLineNumber(popover.lineNumber) - modifiedEditor.getScrollTop()
      setPopover((prev) => (prev ? { ...prev, top } : prev))
    }
    const scrollSub = modifiedEditor.onDidScrollChange(update)
    const contentSub = modifiedEditor.onDidContentSizeChange(update)
    return () => {
      scrollSub.dispose()
      contentSub.dispose()
    }
    // Why: depend on popover.lineNumber (not the whole popover object) so the
    // effect doesn't re-subscribe on every top update it dispatches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modifiedEditor, popover?.lineNumber])

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
  const didAutoScrollFirstDiffRef = useRef(false)
  // Why: the one-shot above is intentionally per-modelKey. Today every call
  // site uses `key={viewStateScopeId}` so the component remounts on model
  // change and the ref is fresh, but the auto-scroll effect lists modelKey in
  // its deps — make that contract honest by resetting the flag when modelKey
  // flips, so a future call site without a remount key still gets a fresh
  // first-diff scroll per file.
  useLayoutEffect(() => {
    didAutoScrollFirstDiffRef.current = false
  }, [modelKey])
  useEffect(() => {
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
      // Why: the decorator owns this scroll for this mount, so permanently
      // yield by setting the one-shot flag. Otherwise, when the decorator
      // ack's and `pendingScrollForThisViewer` flips back to null, this
      // effect would re-run with empty cache + un-set flag and overwrite
      // the comment scroll with a jump to the first diff.
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
      // Defer one frame so any view zones added in this render pass are part
      // of the layout before we measure. Cancel any earlier pending rAF so
      // a late onDidUpdateDiff can't enqueue a redundant scroll.
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
    // If the diff result is already available, run immediately; otherwise
    // wait for it. onDidUpdateDiff fires once the diff computation lands.
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
    // Why: await persistence before closing — if addDiffComment resolves null
    // (store rolled back after IPC failure), keep the popover open so the user
    // can retry instead of silently losing their draft.
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
  const resolvedOriginalModelKey = originalModelKey ?? modelKey
  const resolvedModifiedModelKey = modifiedModelKey ?? modelKey

  const handleMount: DiffOnMount = useCallback(
    (diffEditor, monaco) => {
      diffEditorRef.current = diffEditor
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
        // Cmd/Ctrl+S to save
        modifiedEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
          onSaveRef.current?.(modifiedEditor.getValue())
        })

        // Track changes
        modifiedEditor.onDidChangeModelContent(() => {
          onContentChangeRef.current?.(modifiedEditor.getValue())
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
        setModifiedEditor(null)
        setPopover(null)
      })
    },
    [editable, setupCopy, modelKey, filePath, sideBySide]
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
      <div className="flex-1 min-h-0 relative">
        {popover && hasLineCommentAction && (
          <DiffCommentPopover
            key={popover.lineNumber}
            lineNumber={popover.lineNumber}
            startLine={popover.startLine}
            top={popover.top}
            placeholder={addLineCommentPlaceholder}
            submitLabel={addLineCommentLabel}
            submittingLabel="Posting…"
            onCancel={() => setPopover(null)}
            onSubmit={handleSubmitComment}
          />
        )}
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
          originalModelPath={`diff:original:${resolvedOriginalModelKey}`}
          modifiedModelPath={`diff:modified:${resolvedModifiedModelKey}`}
          keepCurrentOriginalModel
          keepCurrentModifiedModel
          options={{
            readOnly: !editable,
            originalEditable: false,
            renderSideBySide: sideBySide,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            fontSize: editorFontSize,
            fontFamily: settings?.terminalFontFamily || 'monospace',
            lineNumbers: 'on',
            automaticLayout: true,
            renderOverviewRuler: true,
            padding: { top: 0 },
            find: {
              addExtraSpaceOnTop: false,
              autoFindInSelection: 'never',
              seedSearchStringFromSelection: 'never'
            }
          }}
        />
      </div>
      {toastNode}
    </div>
  )
}
