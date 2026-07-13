import type { editor, IRange, ISelection } from 'monaco-editor'

export type MonacoE2ESnapshot = {
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
