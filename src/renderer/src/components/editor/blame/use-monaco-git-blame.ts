import { useEffect, useRef } from 'react'
import type { editor } from 'monaco-editor'
import { useAppStore } from '@/store/index'
import { getEditorFileReadContext } from '@/lib/editor/file-operations/editor-file-operation-owner'
import { getRuntimeGitBlame } from '@/runtime/source-control/git/runtime-git-blame-client'
import type { RuntimeGitContext } from '@/runtime/source-control/git/runtime-git-client-context'
import type { GitBlameResult } from '../../../../../shared/git/blame/git-blame-types'
import { canUseChangesModeForFile } from '../view-mode/editor-panel-file-mode'
import { mapBufferLinesToHead, splitBlameLines, UNCOMMITTED_LINE } from './blame-line-mapping'
import {
  clearFocusedLineBlame,
  publishFocusedLineBlame,
  type LineBlame
} from './git-blame-line-store'
import { blameHoverMarkdown, formatLineBlameSummary } from './git-blame-presentation'

type ReadyBlame = Extract<GitBlameResult, { kind: 'ready' }>
type LoadedBlame = { blame: ReadyBlame; headLines: string[]; git: RuntimeGitContext }

// monaco.editor.CursorChangeReason.Explicit: arrow keys, clicks, go-to; typing is NotSet.
const CURSOR_CHANGE_EXPLICIT = 3

function commitIndexForHeadLine(ranges: number[], headLine: number): number {
  const line = headLine + 1
  let low = 0
  let high = ranges.length / 3 - 1
  while (low <= high) {
    const mid = (low + high) >> 1
    const start = ranges[mid * 3]
    if (line < start) {
      high = mid - 1
    } else if (line >= start + ranges[mid * 3 + 1]) {
      low = mid + 1
    } else {
      return ranges[mid * 3 + 2]
    }
  }
  return -1
}

/**
 * Blame for the cursor line: an inline annotation when enabled, and the focused-line store the
 * status bar reads. Git runs once per HEAD; edits remap the buffer onto the HEAD text instead.
 */
export function useMonacoGitBlame(params: {
  mountedEditor: editor.IStandaloneCodeEditor | null
  fileId: string
  passiveMirror: boolean | undefined
  inlineEnabled: boolean
}): void {
  const { mountedEditor, fileId, passiveMirror, inlineEnabled } = params
  const eligible = useAppStore((state) => {
    const file = state.openFiles.find((entry) => entry.id === fileId)
    return !!file && canUseChangesModeForFile(file)
  })
  const statusBarEnabled = useAppStore((state) => state.statusBarItems.includes('git-blame'))
  const worktreeHead = useAppStore((state) => {
    const file = state.openFiles.find((entry) => entry.id === fileId)
    return file ? (state.gitStatusHeadByWorktree[file.worktreeId] ?? '') : ''
  })
  const enabled = eligible && !passiveMirror && (inlineEnabled || statusBarEnabled)

  const loadedRef = useRef<LoadedBlame | null>(null)
  const mappingRef = useRef<{ versionId: number; mapping: Int32Array | null } | null>(null)
  const typingRef = useRef(false)
  const updateRef = useRef<() => void>(() => {})
  const inlineEnabledRef = useRef(inlineEnabled)
  inlineEnabledRef.current = inlineEnabled

  useEffect(() => {
    const ed = mountedEditor
    if (!ed || !enabled) {
      return
    }
    const decorations = ed.createDecorationsCollection()

    const lineBlameAtCursor = (): LineBlame | null => {
      const loaded = loadedRef.current
      const model = ed.getModel()
      const position = ed.getPosition()
      if (!loaded || !model || !position || typingRef.current) {
        return null
      }
      const versionId = model.getAlternativeVersionId()
      if (mappingRef.current?.versionId !== versionId) {
        mappingRef.current = {
          versionId,
          mapping: mapBufferLinesToHead(loaded.headLines, model.getLinesContent())
        }
      }
      const headLine = mappingRef.current.mapping?.[position.lineNumber - 1]
      if (headLine === undefined) {
        return null
      }
      if (headLine === UNCOMMITTED_LINE) {
        return { kind: 'uncommitted' }
      }
      const commit = loaded.blame.commits[commitIndexForHeadLine(loaded.blame.ranges, headLine)]
      return commit ? { kind: 'commit', commit } : null
    }

    const update = (): void => {
      const line = lineBlameAtCursor()
      const position = ed.getPosition()
      if (!line || !position || !inlineEnabledRef.current) {
        decorations.clear()
      } else {
        const column = ed.getModel()?.getLineMaxColumn(position.lineNumber) ?? 1
        decorations.set([
          {
            range: {
              startLineNumber: position.lineNumber,
              startColumn: column,
              endLineNumber: position.lineNumber,
              endColumn: column
            },
            options: {
              showIfCollapsed: true,
              after: {
                content: formatLineBlameSummary(line),
                inlineClassName: 'orca-git-blame-inline'
              },
              ...(line.kind === 'commit' ? { hoverMessage: blameHoverMarkdown(line.commit) } : {})
            }
          }
        ])
      }
      const focused = ed.hasTextFocus() || useAppStore.getState().activeFileId === fileId
      if (focused) {
        const git = loadedRef.current?.git
        publishFocusedLineBlame(line && git ? { fileId, line, git } : null)
      }
    }
    updateRef.current = update

    const disposables = [
      ed.onDidChangeModelContent(() => {
        // Hide while typing; the next explicit cursor move shows the remapped line.
        typingRef.current = true
        update()
      }),
      ed.onDidChangeCursorPosition((event) => {
        if (event.reason === CURSOR_CHANGE_EXPLICIT || event.source === 'mouse') {
          typingRef.current = false
        }
        update()
      }),
      ed.onDidFocusEditorText(update)
    ]
    update()
    return () => {
      for (const disposable of disposables) {
        disposable.dispose()
      }
      decorations.clear()
      updateRef.current = () => {}
      clearFocusedLineBlame(fileId)
    }
  }, [mountedEditor, enabled, fileId])

  // HEAD moving is the only thing that changes blame; main answers repeats from its cache.
  useEffect(() => {
    if (!enabled) {
      loadedRef.current = null
      mappingRef.current = null
      return
    }
    let cancelled = false
    const state = useAppStore.getState()
    const file = state.openFiles.find((entry) => entry.id === fileId)
    if (!file) {
      return
    }
    const worktreePath = file.filePath.slice(0, file.filePath.length - file.relativePath.length - 1)
    let context: RuntimeGitContext
    try {
      const { target, connectionId } = getEditorFileReadContext(state, file, worktreePath)
      context = { target, worktreeId: file.worktreeId, worktreePath, connectionId }
    } catch {
      // The file's owner is unresolved or changed; blame stays hidden.
      return
    }
    void getRuntimeGitBlame(context, file.relativePath).then((result) => {
      if (cancelled) {
        return
      }
      loadedRef.current =
        result.kind === 'ready'
          ? { blame: result, headLines: splitBlameLines(result.headText), git: context }
          : null
      mappingRef.current = null
      updateRef.current()
    })
    return () => {
      cancelled = true
    }
  }, [enabled, fileId, worktreeHead])
}
