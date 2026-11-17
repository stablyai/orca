import { useEffect, useRef } from 'react'
import type { editor } from 'monaco-editor'
import { useAppStore } from '@/store/index'
import { getRuntimeGitBlame } from '@/runtime/source-control/git/runtime-git-blame-client'
import type { GitBlameResult } from '../../../../../shared/git/blame/git-blame-types'
import { canUseChangesModeForFile } from '../view-mode/editor-panel-file-mode'
import { mapBufferLinesToHead, splitBlameLines, UNCOMMITTED_LINE } from './blame-line-mapping'
import {
  releaseFocusedLineBlame,
  getFocusedLineBlame,
  publishFocusedLineBlame,
  type LineBlame
} from './git-blame-line-store'
import { blameHoverMarkdown, formatLineBlameSummary } from './git-blame-presentation'
import { openFileById, resolveGitBlameTarget, type GitBlameTarget } from './git-blame-target'

type ReadyBlame = Extract<GitBlameResult, { kind: 'ready' }>
type LoadedBlame = { blame: ReadyBlame; headLines: string[]; target: GitBlameTarget }

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
    const file = openFileById(state.openFiles, fileId)
    return !!file && canUseChangesModeForFile(file)
  })
  const statusBarEnabled = useAppStore(
    (state) => state.statusBarVisible && state.statusBarItems.includes('git-blame')
  )
  const enabled = eligible && !passiveMirror && (inlineEnabled || statusBarEnabled)

  // Survives inline-toggle reruns; a different file or HEAD replaces it on the next load.
  const loadedRef = useRef<LoadedBlame | null>(null)

  useEffect(() => {
    const ed = mountedEditor
    if (!ed || !enabled) {
      loadedRef.current = null
      return
    }
    const ownerId = ed.getId()
    const decorations = ed.createDecorationsCollection()
    let mapping: { versionId: number; lines: Int32Array | null } | null = null
    let typing = false
    let loading = true
    let disposed = false
    let headKey: string | null = null

    const lineBlameAtCursor = (): LineBlame | null => {
      const loaded = loadedRef.current
      const model = ed.getModel()
      const position = ed.getPosition()
      if (!loaded || !model || !position) {
        return null
      }
      const versionId = model.getAlternativeVersionId()
      if (mapping?.versionId !== versionId) {
        mapping = {
          versionId,
          lines: mapBufferLinesToHead(loaded.headLines, model.getLinesContent())
        }
      }
      const headLine = mapping.lines?.[position.lineNumber - 1]
      if (headLine === undefined) {
        return null
      }
      if (headLine === UNCOMMITTED_LINE) {
        return { kind: 'uncommitted' }
      }
      const commit = loaded.blame.commits[commitIndexForHeadLine(loaded.blame.ranges, headLine)]
      return commit ? { kind: 'commit', commit } : null
    }

    // The focused pane is active; the active file also takes over from another file or a closed
    // tab, but never from a live split pane of itself.
    const isActivePane = (): boolean => {
      const current = getFocusedLineBlame()
      return (
        ed.hasTextFocus() ||
        current?.ownerId === ownerId ||
        (useAppStore.getState().activeFileId === fileId &&
          (!current || current.fileId !== fileId || current.released))
      )
    }

    const publish = (line: LineBlame | null): void => {
      const current = getFocusedLineBlame()
      if (line) {
        const git = loadedRef.current?.target.git ?? null
        publishFocusedLineBlame({ ownerId, fileId, line, stale: false, released: false, git })
      } else if (current && (typing || loading)) {
        // Keep the last value, dimmed, so the status bar doesn't shift while typing or loading.
        publishFocusedLineBlame({ ...current, ownerId, fileId, stale: true, released: false })
      } else {
        publishFocusedLineBlame(null)
      }
    }

    const update = (): void => {
      // Inactive panes do no work: a split of the same file would otherwise remap per keystroke.
      if (!isActivePane()) {
        decorations.clear()
        return
      }
      const position = ed.getPosition()
      const line = typing ? null : lineBlameAtCursor()
      if (!line || !position || !inlineEnabled) {
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
      publish(line)
    }

    // Main answers from its commit-keyed cache unless HEAD moved, so reloading is one rev-parse.
    const loads = { generation: 0 }
    // `focus`: HEAD probably unchanged, so a failed reply keeps blame. `status`: the HEAD entry
    // appeared or vanished, so HEAD may have moved. `headMoved`: it did; hide the old baseline now.
    const load = (reason: 'focus' | 'status' | 'headMoved'): void => {
      // Invalidate any pending reply first, including when no target resolves below.
      loads.generation += 1
      const generation = loads.generation
      const state = useAppStore.getState()
      const file = openFileById(state.openFiles, fileId)
      const target = file ? resolveGitBlameTarget(state, file) : null
      headKey = target?.git.worktreeId ?? null
      if (!target) {
        loading = false
        loadedRef.current = null
        update()
        return
      }
      if (reason === 'headMoved' && loadedRef.current) {
        // The old baseline no longer matches HEAD: hide it (the status bar dims) until the reply.
        loading = true
        loadedRef.current = null
        mapping = null
        update()
      }
      const known = loadedRef.current
      const sameFile =
        known !== null &&
        known.target.git.worktreeId === target.git.worktreeId &&
        known.target.git.worktreePath === target.git.worktreePath &&
        known.target.relativePath === target.relativePath
      // Main answers `unchanged` when HEAD hasn't moved, so a focus reload resends nothing.
      const knownHeadOid = sameFile ? known.blame.headOid : undefined
      void getRuntimeGitBlame(target.git, target.relativePath, knownHeadOid).then((result) => {
        if (disposed || generation !== loads.generation) {
          return
        }
        loading = false
        const previous = loadedRef.current
        const keep =
          sameFile &&
          previous &&
          (result.kind === 'unchanged' ||
            // Only a failed focus reload keeps blame; HEAD may have moved otherwise.
            (result.kind === 'unavailable' && reason === 'focus') ||
            (result.kind === 'ready' && result.headOid === previous.blame.headOid))
        if (keep) {
          loadedRef.current = { ...previous, target }
          // The target can resolve later (a child repo's worktree id), so refresh the click target.
          update()
          return
        }
        loadedRef.current =
          result.kind === 'ready'
            ? { blame: result, headLines: splitBlameLines(result.headText), target }
            : null
        mapping = null
        update()
      })
    }

    const disposables = [
      ed.onDidChangeModelContent((event) => {
        // Only the user's own typing hides blame; agent writes and format-on-save don't. Undo and
        // redo restore known text and move the cursor with no explicit reason, so show it at once.
        if (event.isUndoing || event.isRedoing) {
          typing = false
        } else if (ed.hasTextFocus()) {
          typing = true
        }
        update()
      }),
      ed.onDidChangeCursorPosition((event) => {
        if (event.reason === CURSOR_CHANGE_EXPLICIT || event.source === 'mouse') {
          typing = false
        }
        update()
      }),
      // Commits made in a terminal or in a child repo surface when the user returns to the editor.
      ed.onDidFocusEditorText(() => {
        update()
        load('focus')
      })
    ]
    const unsubscribeHead = useAppStore.subscribe((state, previous) => {
      const before = headKey ? previous.gitStatusHeadByWorktree[headKey] : undefined
      const after = headKey ? state.gitStatusHeadByWorktree[headKey] : undefined
      if (before === after) {
        return
      }
      // The first status after launch, or a failed status read, isn't HEAD moving: no flicker.
      load(before !== undefined && after !== undefined ? 'headMoved' : 'status')
    })
    update()
    load('status')
    return () => {
      disposed = true
      for (const disposable of disposables) {
        disposable.dispose()
      }
      unsubscribeHead()
      decorations.clear()
      // Dimmed, not cleared: the next active editor takes it over without the status bar shifting.
      releaseFocusedLineBlame(ownerId)
    }
  }, [mountedEditor, enabled, fileId, inlineEnabled])
}
