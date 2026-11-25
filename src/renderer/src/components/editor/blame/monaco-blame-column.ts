import type { editor } from 'monaco-editor'
import type { GitBlameCommit } from '../../../../../shared/git/blame/git-blame-types'
import {
  BLAME_COLUMN_MIN_CHARS,
  blameAgeLevels,
  formatBlameColumnLine,
  groupBlameLinesByCommit,
  PLAIN_LINE_NUMBER_OPTIONS
} from './git-blame-column'
import type { LineBlame } from './git-blame-line-store'
import { blameHoverMarkdown } from './git-blame-presentation'

// Grouping is O(lines), so hover tooltips rebuild after typing pauses, not on every keystroke.
const HOVER_REBUILD_DELAY_MS = 250

type LoadedBlame = { blame: { commits: readonly GitBlameCommit[] } }

type BlameColumnSource = {
  loaded: () => LoadedBlame | null
  lineBlameAt: (lineNumber: number) => LineBlame | null
}

/** Date and author beside every line number, with the commit details on hover. */
export function createBlameColumn(
  ed: editor.IStandaloneCodeEditor,
  source: BlameColumnSource
): { sync: () => void; dispose: () => void } {
  let renderer: ((lineNumber: number) => string) | null = null
  let rendererFor: LoadedBlame | null = null
  const hover = ed.createDecorationsCollection()
  let hoverFor: { loaded: LoadedBlame; versionId: number } | null = null
  let hoverTimer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  // MonacoEditor re-sends `lineNumbers: 'on'` on re-render; put the column back.
  const configSubscription = ed.onDidChangeConfiguration(() => {
    if (renderer && ed.getRawOptions().lineNumbers !== renderer) {
      ed.updateOptions({ lineNumbers: renderer })
    }
  })

  // Monaco repaints line numbers only when the option changes, so a new loaded blame installs a
  // new function. Edits need no refresh: Monaco repaints and the function remaps per version.
  const syncRenderer = (): void => {
    const loaded = source.loaded()
    if (loaded === rendererFor) {
      return
    }
    rendererFor = loaded
    if (!loaded) {
      renderer = null
      ed.updateOptions(PLAIN_LINE_NUMBER_OPTIONS)
      return
    }
    const ageLevels = blameAgeLevels(loaded.blame.commits)
    const next = (lineNumber: number): string =>
      formatBlameColumnLine(lineNumber, source.lineBlameAt(lineNumber), ageLevels)
    renderer = next
    ed.updateOptions({ lineNumbers: next, lineNumbersMinChars: BLAME_COLUMN_MIN_CHARS })
  }

  const cancelHoverRebuild = (): void => {
    if (hoverTimer) {
      clearTimeout(hoverTimer)
      hoverTimer = null
    }
  }

  // Decorations follow edits, so an edited line keeps its old commit's tooltip until the rebuild.
  const rebuildHover = (): void => {
    hoverTimer = null
    const model = ed.getModel()
    const loaded = source.loaded()
    if (disposed || !model || !loaded) {
      return
    }
    hoverFor = { loaded, versionId: model.getAlternativeVersionId() }
    hover.set(
      groupBlameLinesByCommit(model.getLineCount(), source.lineBlameAt).map((group) => ({
        range: {
          startLineNumber: group.startLine,
          startColumn: 1,
          endLineNumber: group.endLine,
          endColumn: 1
        },
        options: { isWholeLine: true, lineNumberHoverMessage: blameHoverMarkdown(group.commit) }
      }))
    )
  }

  const syncHover = (): void => {
    const model = ed.getModel()
    const loaded = source.loaded()
    if (!model || !loaded) {
      cancelHoverRebuild()
      hover.clear()
      hoverFor = null
      return
    }
    if (hoverFor?.loaded !== loaded) {
      cancelHoverRebuild()
      rebuildHover()
      return
    }
    // Cursor moves reach here too; only an edit changes the groups.
    if (hoverFor.versionId !== model.getAlternativeVersionId()) {
      cancelHoverRebuild()
      hoverTimer = setTimeout(rebuildHover, HOVER_REBUILD_DELAY_MS)
    }
  }

  return {
    sync: () => {
      syncRenderer()
      syncHover()
    },
    dispose: () => {
      disposed = true
      cancelHoverRebuild()
      hover.clear()
      configSubscription.dispose()
      // A disposed editor has no model; skip it instead of updating a dead editor.
      if (ed.getModel()) {
        ed.updateOptions(PLAIN_LINE_NUMBER_OPTIONS)
      }
    }
  }
}
