import type { editor, IRange, ISelection } from 'monaco-editor'

export type MonacoE2ESnapshot = {
  canUndo: boolean
  contentHeight: number
  scrollHeight: number
  scrollTop: number
  visibleRanges: IRange[]
  selection: ISelection | null
  valueLength: number
  valueTail: string
  find: {
    open: boolean
    query: string
    activeMatch: string
  }
}

export type MonacoE2EProbe = {
  filePath: string
  restoreLegacySetValueControl: () => void
  restoreScrollTop: (scrollTop: number) => void
  runLegacySetValueAppend: (suffix: string) => void
  /** Trigger F12 / go-to-definition at the current cursor. */
  revealDefinition: () => void
  /** Trigger Shift+F12 / find references at the current cursor (peek widget). */
  triggerReferences: () => void
  /** Show the hover widget at the current cursor (mirrors Ctrl+K hover). */
  showHover: () => void
  /** Move the cursor to a 1-based line/column so hover/definition target a symbol. */
  setCursorPosition: (line: number, column: number) => void
  /** Insert text at a 1-based line/column as a single edit operation (real model change). */
  insertText: (line: number, column: number, text: string) => void
  /** Trigger the editor undo stack (mirrors Cmd/Ctrl+Z without key event flakiness). */
  undo: () => void
  /** Apply several edits as ONE model change event (multi-change single gesture). */
  applyEdits: (edits: readonly { range: IRange; text: string }[]) => void
  /** DOM color histogram of rendered line spans (semantic-token coloring signal). */
  colorHistogram: () => { distinctColors: number; byColor: Record<string, number> }
  snapshot: () => MonacoE2ESnapshot
}

export function installMonacoE2EProbe(
  editorInstance: editor.IStandaloneCodeEditor,
  filePath: string
): () => void {
  if (import.meta.env.MODE !== 'e2e') {
    return () => {}
  }
  let legacyControlOriginalValue: string | null = null
  let legacyControlIncomingValue: string | null = null
  const probe: MonacoE2EProbe = {
    filePath,
    runLegacySetValueAppend: (suffix: string): void => {
      if (legacyControlOriginalValue !== null) {
        throw new Error('Legacy control must be restored before running again')
      }
      legacyControlOriginalValue = editorInstance.getValue()
      // Why: the former controlled wrapper retained a flat IPC-delivered prop
      // while setValue rebuilt the model; preserve that ownership in the control.
      legacyControlIncomingValue = new TextDecoder().decode(
        new TextEncoder().encode(`${legacyControlOriginalValue}${suffix}`)
      )
      // Why: reproduces the former controlled read-only wrapper's unconditional
      // whole-model setValue without exposing a switch in production builds.
      editorInstance.setValue(legacyControlIncomingValue)
    },
    restoreLegacySetValueControl: (): void => {
      if (legacyControlOriginalValue === null) {
        return
      }
      editorInstance.setValue(legacyControlOriginalValue)
      legacyControlOriginalValue = null
      legacyControlIncomingValue = null
    },
    restoreScrollTop: (scrollTop: number): void => {
      // Why: the legacy setValue control can perturb Monaco's pixel rounding;
      // paired fixed-path measurements must start from the recorded geometry.
      editorInstance.setScrollTop(scrollTop)
    },
    revealDefinition: (): void => {
      // Why: F12 in a hidden window is unreliable as a keypress; drive the same
      // editor action the keybinding would, which routes through our
      // registerEditorOpener (spike findings §1, blocker B).
      editorInstance.trigger('e2e', 'editor.action.revealDefinition', null)
    },
    triggerReferences: (): void => {
      // Why: Shift+F12 in a hidden window is unreliable as a keypress; drive the
      // same action the keybinding would (editor.action.referenceSearch.trigger)
      // which mounts Monaco's peek references widget — already customized by
      // installMonacoPeekReferencesPreviewOptions in monaco-setup.ts.
      editorInstance.trigger('e2e', 'editor.action.referenceSearch.trigger', null)
    },
    showHover: (): void => {
      // Why: hover is mouse-driven in real use; the showHover action renders
      // the same hover widget at the current cursor for DOM assertion.
      editorInstance.trigger('e2e', 'editor.action.showHover', null)
    },
    setCursorPosition: (line: number, column: number): void => {
      editorInstance.setPosition({ lineNumber: line, column })
      editorInstance.revealLineInCenter(line)
    },
    insertText: (line: number, column: number, text: string): void => {
      // executeEdits records into the editor's undo stack so the undo() probe
      // can revert it; model.applyEdits would not, and the edit churn test
      // gates on undo restoring the original content.
      editorInstance.executeEdits('e2e', [
        {
          range: {
            startLineNumber: line,
            startColumn: column,
            endLineNumber: line,
            endColumn: column
          },
          text,
          forceMoveMarkers: true
        }
      ])
    },
    undo: (): void => {
      // Why: a keypress in a hidden window doesn't reliably reach Monaco's
      // undo stack; the editor action is the same path the keybinding runs.
      editorInstance.trigger('e2e', 'undo', null)
    },
    applyEdits: (edits: readonly { range: IRange; text: string }[]): void => {
      editorInstance.executeEdits(
        'e2e',
        edits.map((edit) => ({ ...edit, forceMoveMarkers: true }))
      )
    },
    colorHistogram: (): { distinctColors: number; byColor: Record<string, number> } => {
      // spike findings §1: getComputedStyle/DOM histograms are the authoritative
      // semantic-color signal (CDP screenshots freeze a stale frame in a hidden
      // window — pixel sampling false-negatives). Counts the distinct computed
      // `color` values across rendered line spans.
      const container = editorInstance.getContainerDomNode()
      const spans = container.querySelectorAll<HTMLElement>('.view-lines .view-line span')
      const byColor: Record<string, number> = {}
      for (const s of spans) {
        const color = getComputedStyle(s).color
        byColor[color] = (byColor[color] ?? 0) + 1
      }
      return { distinctColors: Object.keys(byColor).length, byColor }
    },
    snapshot: (): MonacoE2ESnapshot => {
      const container = editorInstance.getContainerDomNode()
      const findWidget = container.querySelector<HTMLElement>('.find-widget')
      const findInput = findWidget?.querySelector<HTMLInputElement | HTMLTextAreaElement>('.input')
      const model = editorInstance.getModel()
      const valueLength = model?.getValueLength() ?? 0
      const lastLineNumber = model?.getLineCount() ?? 1
      const lastLine = model?.getLineContent(lastLineNumber) ?? ''
      const lastNonEmptyLine =
        lastLine || lastLineNumber === 1
          ? lastLine
          : (model?.getLineContent(lastLineNumber - 1) ?? '')
      return {
        canUndo: model?.canUndo() ?? false,
        contentHeight: editorInstance.getContentHeight(),
        scrollHeight: editorInstance.getScrollHeight(),
        scrollTop: editorInstance.getScrollTop(),
        visibleRanges: [...editorInstance.getVisibleRanges()],
        selection: editorInstance.getSelection(),
        valueLength,
        valueTail: lastNonEmptyLine.slice(-256),
        find: {
          open: findWidget?.getAttribute('aria-hidden') !== 'true',
          query: findInput?.value ?? '',
          activeMatch:
            findWidget?.querySelector<HTMLElement>('.matchesCount')?.textContent?.trim() ?? ''
        }
      }
    }
  }
  window.__monacoEditorE2E = probe
  return () => {
    if (window.__monacoEditorE2E === probe) {
      delete window.__monacoEditorE2E
    }
  }
}
