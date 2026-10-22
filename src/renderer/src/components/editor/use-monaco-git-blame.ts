import { useEffect, useRef, useState } from 'react'
import type { editor } from 'monaco-editor'
import { useShallow } from 'zustand/react/shallow'
import type { GitBlameResult } from '../../../../shared/git-blame-types'
import { findGitBlameHunkForLine } from '../../../../shared/git-blame-porcelain-parser'
import { useAppStore } from '@/store'
import { getConnectionIdForFile } from '@/lib/connection-context'
import { getRuntimeTargetForFileOwner } from '@/lib/file-owner-runtime-target'
import { getRuntimeGitFileBlame } from '@/runtime/runtime-git-blame-client'
import { canUseGitBlameForFile } from './editor-panel-file-mode'
import {
  formatGitBlameHoverMarkdown,
  formatGitBlameInlineText
} from './git-blame-annotation-format'

const CLEAN_FETCH_DELAY_MS = 150
// Why: a dirty buffer re-blames via stdin, so wait for a typing pause instead of spawning per keystroke.
const DIRTY_FETCH_DELAY_MS = 1000
// Columns taken by the annotation's 3em left padding, rounded up for proportional fallbacks.
const ANNOTATION_PADDING_COLUMNS = 6

type BlameSnapshot = { result: GitBlameResult; content: string }

/** Shows author, age, and summary after the cursor line (GitLens-style current-line blame). */
export function useMonacoGitBlame(params: {
  mountedEditor: editor.IStandaloneCodeEditor | null
  fileId: string
  content: string
  enabled: boolean
}): void {
  const { mountedEditor, fileId, content, enabled } = params
  const file = useAppStore(
    useShallow((s) => {
      // Why: this selector runs on every store write, so skip the worktree scan while blame is off.
      if (!enabled) {
        return null
      }
      const entry = s.openFiles?.find((candidate) => candidate.id === fileId)
      return entry && canUseGitBlameForFile(s, entry)
        ? {
            filePath: entry.filePath,
            relativePath: entry.relativePath,
            worktreeId: entry.worktreeId,
            runtimeEnvironmentId: entry.runtimeEnvironmentId,
            isDirty: entry.isDirty
          }
        : null
    })
  )
  // Why: a commit, checkout, or rebase moves HEAD and changes attribution without editing the buffer.
  const head = useAppStore((s) =>
    file ? (s.gitStatusHeadByWorktree?.[file.worktreeId] ?? null) : null
  )
  const [snapshot, setSnapshot] = useState<BlameSnapshot | null>(null)
  const [cursorLine, setCursorLine] = useState<number | null>(null)
  // Wrapping width in columns; 0 when lines scroll instead of wrapping.
  const [viewportColumns, setViewportColumns] = useState(0)
  const decorationsRef = useRef<editor.IEditorDecorationsCollection | null>(null)

  useEffect(() => {
    if (!enabled || !file) {
      setSnapshot(null)
      return
    }
    let cancelled = false
    const requestedContent = content
    const timer = setTimeout(
      () => {
        const state = useAppStore.getState()
        const target = getRuntimeTargetForFileOwner(
          state,
          file.worktreeId,
          file.runtimeEnvironmentId
        )
        if (!target) {
          return
        }
        void getRuntimeGitFileBlame(
          {
            target,
            worktreeId: file.worktreeId,
            worktreePath: file.filePath.slice(
              0,
              file.filePath.length - file.relativePath.length - 1
            ),
            connectionId: getConnectionIdForFile(file.worktreeId, file.filePath) ?? undefined
          },
          {
            filePath: file.relativePath,
            contents: file.isDirty ? requestedContent : undefined
          }
        )
          .then((result) => {
            if (!cancelled) {
              setSnapshot(result ? { result, content: requestedContent } : null)
            }
          })
          .catch(() => {
            if (!cancelled) {
              setSnapshot(null)
            }
          })
      },
      file.isDirty ? DIRTY_FETCH_DELAY_MS : CLEAN_FETCH_DELAY_MS
    )
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [content, enabled, file, head])

  useEffect(() => {
    if (!mountedEditor || !enabled) {
      setCursorLine(null)
      return
    }
    setCursorLine(mountedEditor.getPosition()?.lineNumber ?? null)
    const layout = mountedEditor.getLayoutInfo()
    setViewportColumns(layout.isViewportWrapping ? layout.viewportColumn : 0)
    const cursorSubscription = mountedEditor.onDidChangeCursorPosition((event) => {
      setCursorLine(event.position.lineNumber)
    })
    const layoutSubscription = mountedEditor.onDidLayoutChange((next) => {
      setViewportColumns(next.isViewportWrapping ? next.viewportColumn : 0)
    })
    return () => {
      cursorSubscription.dispose()
      layoutSubscription.dispose()
    }
  }, [enabled, mountedEditor])

  useEffect(() => {
    const ed = mountedEditor
    const model = ed?.getModel()
    // Why: until the re-blame lands, old line numbers would attribute edited lines to the wrong commit.
    if (!ed || !model || !snapshot || snapshot.content !== content || cursorLine === null) {
      decorationsRef.current?.clear()
      return
    }
    const hunk = findGitBlameHunkForLine(snapshot.result.hunks, cursorLine)
    const commit = hunk ? snapshot.result.commits[hunk.sha] : undefined
    if (!commit || cursorLine > model.getLineCount()) {
      decorationsRef.current?.clear()
      return
    }
    const now = Date.now()
    const endColumn = model.getLineMaxColumn(cursorLine)
    // Why: injected text wraps like code, so an annotation wider than the free space would push lines down.
    const lastRowColumns = viewportColumns > 0 ? (endColumn - 1) % viewportColumns : 0
    const text = formatGitBlameInlineText(
      commit,
      now,
      viewportColumns > 0
        ? viewportColumns - lastRowColumns - ANNOTATION_PADDING_COLUMNS
        : Number.POSITIVE_INFINITY
    )
    if (!text) {
      decorationsRef.current?.clear()
      return
    }
    const decorations: editor.IModelDeltaDecoration[] = [
      {
        range: {
          startLineNumber: cursorLine,
          startColumn: endColumn,
          endLineNumber: cursorLine,
          endColumn
        },
        options: {
          showIfCollapsed: true,
          hoverMessage: { value: formatGitBlameHoverMarkdown(commit, now) },
          after: {
            content: text,
            inlineClassName: 'orca-git-blame-inline'
          }
        }
      }
    ]
    if (!decorationsRef.current) {
      decorationsRef.current = ed.createDecorationsCollection(decorations)
      return
    }
    decorationsRef.current.set(decorations)
  }, [content, cursorLine, mountedEditor, snapshot, viewportColumns])

  useEffect(() => {
    return () => {
      decorationsRef.current?.clear()
      decorationsRef.current = null
    }
  }, [])
}
