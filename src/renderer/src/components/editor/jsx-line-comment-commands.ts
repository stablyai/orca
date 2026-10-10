import type { editor, Selection } from 'monaco-editor'
import { LineCommentCommand } from 'monaco-editor/esm/vs/editor/contrib/comment/browser/lineCommentCommand.js'

const jsxCommentConfiguration = {
  getLanguageConfiguration: () => ({
    comments: { blockCommentStartToken: '{/*', blockCommentEndToken: '*/}' }
  })
}

export function getCommentEndLine(selection: Selection): number {
  return selection.endLineNumber > selection.startLineNumber && selection.endColumn === 1
    ? selection.endLineNumber - 1
    : selection.endLineNumber
}

export function createJsxLineCommentCommands(
  model: editor.ITextModel,
  selections: Selection[],
  options: { insertSpace: boolean; ignoreEmptyLines: boolean }
): editor.ICommand[] | null {
  const ranges = selections
    .map((selection) => ({ start: selection.startLineNumber, end: getCommentEndLine(selection) }))
    .sort((left, right) => left.start - right.start)
  if (ranges.some((range, index) => index > 0 && range.start <= ranges[index - 1].end)) {
    return null
  }
  for (const selection of selections) {
    const endLine = getCommentEndLine(selection)
    const text = model.getValueInRange({
      startLineNumber: selection.startLineNumber,
      startColumn: 1,
      endLineNumber: endLine,
      endColumn: model.getLineMaxColumn(endLine)
    })
    const start = text.indexOf('{/*')
    const end = text.indexOf('*/')
    // Native block fallback can join separate pairs or nest an existing closing delimiter.
    if (
      start !== text.lastIndexOf('{/*') ||
      end !== text.lastIndexOf('*/') ||
      (start === -1) !== (end === -1) ||
      (start !== -1 && (start > end || !text.startsWith('*/}', end)))
    ) {
      return null
    }
    if (start !== -1) {
      const endColumn =
        endLine === selection.endLineNumber ? selection.endColumn : model.getLineMaxColumn(endLine)
      const selectionEnd = text.length - (model.getLineMaxColumn(endLine) - endColumn)
      const insidePair = selection.startColumn - 1 >= start && selectionEnd <= end + 3
      const wholePair = text.trimStart().startsWith('{/*') && text.trimEnd().endsWith('*/}')
      // The native removal search only visits the selected boundary lines.
      if (!insidePair && !wholePair) {
        return null
      }
    }
  }
  return selections.map(
    (selection) =>
      new LineCommentCommand(
        jsxCommentConfiguration,
        selection,
        model.getOptions().indentSize,
        0,
        options.insertSpace,
        options.ignoreEmptyLines,
        false
      )
  )
}
