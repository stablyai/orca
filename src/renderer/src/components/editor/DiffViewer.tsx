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

type DiffViewerProps = {
  modelKey: string
  originalContent: string
  modifiedContent: string
  language: string
  filePath: string
  relativePath: string
  sideBySide: boolean
  editable?: boolean
  // Why: optional because DiffViewer is also used by GitHubItemDrawer for PR
  // review, where there is no local worktree to attach comments to. When
  // omitted, the per-line comment decorator is skipped.
  worktreeId?: string
  onContentChange?: (content: string) => void
  onSave?: (content: string) => void
}

export default function DiffViewer({
  modelKey,
  originalContent,
  modifiedContent,
  language,
  filePath,
  relativePath,
  sideBySide,
  editable,
  worktreeId,
  onContentChange,
  onSave
}: DiffViewerProps): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const editorFontZoomLevel = useAppStore((s) => s.editorFontZoomLevel)
  const addDiffComment = useAppStore((s) => s.addDiffComment)
  const deleteDiffComment = useAppStore((s) => s.deleteDiffComment)
  // Why: subscribe to the raw comments array on the worktree so selector
  // identity only changes when diffComments actually changes on this worktree.
  // Filtering by relativePath happens in a memo below.
  const allDiffComments = useAppStore((s): DiffComment[] | undefined =>
    worktreeId ? findWorktreeById(s.worktreesByRepo, worktreeId)?.diffComments : undefined
  )
  const diffComments = useMemo(
    () => (allDiffComments ?? []).filter((c) => c.filePath === relativePath),
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
  const [popover, setPopover] = useState<{ lineNumber: number; top: number } | null>(null)

  // Why: gate the decorator on having a worktreeId. DiffViewer is reused by
  // GitHubItemDrawer (PR review) where there is no local worktree to own the
  // comment. Pass a nulled editor so the hook no-ops rather than calling it
  // conditionally, which would violate the rules of hooks.
  useDiffCommentDecorator({
    editor: worktreeId ? modifiedEditor : null,
    filePath: relativePath,
    worktreeId: worktreeId ?? '',
    comments: diffComments,
    onAddCommentClick: ({ lineNumber, top }) => setPopover({ lineNumber, top }),
    onDeleteComment: (id) => {
      if (worktreeId) {
        void deleteDiffComment(worktreeId, id)
      }
    }
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

  const handleSubmitComment = async (body: string): Promise<void> => {
    if (!popover || !worktreeId) {
      return
    }
    // Why: await persistence before closing — if addDiffComment resolves null
    // (store rolled back after IPC failure), keep the popover open so the user
    // can retry instead of silently losing their draft.
    const result = await addDiffComment({
      worktreeId,
      filePath: relativePath,
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

      diffEditor.onDidDispose(() => {
        lineNumberOptionsSubRef.current?.dispose()
        lineNumberOptionsSubRef.current = null
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
        {popover && worktreeId && (
          <DiffCommentPopover
            key={popover.lineNumber}
            lineNumber={popover.lineNumber}
            top={popover.top}
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
          originalModelPath={`diff:original:${modelKey}`}
          modifiedModelPath={`diff:modified:${modelKey}`}
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
