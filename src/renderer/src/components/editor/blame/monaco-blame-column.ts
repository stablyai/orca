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

// A blame lookup remaps the whole buffer onto HEAD (up to 50 ms) and tooltip grouping is O(lines), so
// after an edit the column shows plain numbers and no tooltips until the editor has been quiet this long.
const EDIT_SETTLE_DELAY_MS = 250

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
  const modelVersion = (): number | undefined => ed.getModel()?.getAlternativeVersionId()
  let renderer: ((lineNumber: number) => string) | null = null
  let rendererFor: LoadedBlame | null = null
  let ageLevels: ReadonlyMap<string, number> = new Map()
  const hover = ed.createDecorationsCollection()
  let hoverFor: LoadedBlame | null = null
  // The model version blame is drawn for; any other version is an edit still waiting for its pause.
  let settledVersion = modelVersion()
  let settleTimer: ReturnType<typeof setTimeout> | null = null

  // MonacoEditor re-sends `lineNumbers: 'on'` on re-render; put the column back.
  const configSubscription = ed.onDidChangeConfiguration(() => {
    if (renderer && ed.getRawOptions().lineNumbers !== renderer) {
      ed.updateOptions({ lineNumbers: renderer })
    }
  })

  // Monaco repaints line numbers only when the option changes, so a new loaded blame or a settled
  // edit installs a new function. Edits repaint on their own, and until the pause the function draws
  // plain numbers, so typing runs no blame lookup.
  const installRenderer = (): void => {
    const next = (lineNumber: number): string =>
      modelVersion() === settledVersion
        ? formatBlameColumnLine(lineNumber, source.lineBlameAt(lineNumber), ageLevels)
        : String(lineNumber)
    renderer = next
    ed.updateOptions({ lineNumbers: next, lineNumbersMinChars: BLAME_COLUMN_MIN_CHARS })
  }

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
    ageLevels = blameAgeLevels(loaded.blame.commits)
    installRenderer()
  }

  const cancelSettle = (): void => {
    if (settleTimer) {
      clearTimeout(settleTimer)
      settleTimer = null
    }
  }

  const rebuildHover = (): void => {
    const model = ed.getModel()
    const loaded = source.loaded()
    if (!model || !loaded) {
      return
    }
    hoverFor = loaded
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

  // Edits paused: draw blame for the new text and regroup its tooltips.
  const settle = (): void => {
    settleTimer = null
    settledVersion = modelVersion()
    if (renderer) {
      installRenderer()
    }
    rebuildHover()
  }

  return {
    sync: () => {
      syncRenderer()
      const loaded = source.loaded()
      cancelSettle()
      if (!ed.getModel() || !loaded) {
        hover.clear()
        hoverFor = null
      } else if (modelVersion() !== settledVersion) {
        // Decorations follow edits, so an edited line would keep its old commit's tooltip.
        hover.clear()
        hoverFor = null
        settleTimer = setTimeout(settle, EDIT_SETTLE_DELAY_MS)
      } else if (hoverFor !== loaded) {
        rebuildHover()
      }
    },
    dispose: () => {
      cancelSettle()
      hover.clear()
      configSubscription.dispose()
      // A disposed editor has no model; skip it instead of updating a dead editor.
      if (ed.getModel()) {
        ed.updateOptions(PLAIN_LINE_NUMBER_OPTIONS)
      }
    }
  }
}
