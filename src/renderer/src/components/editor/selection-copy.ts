import type { IRange } from 'monaco-editor'

type FormatCopiedSelectionArgs = {
  relativePath: string
  language: string
  selection: IRange
  selectedText: string
}

export function formatCopiedSelectionWithContext({
  relativePath,
  language,
  selection,
  selectedText
}: FormatCopiedSelectionArgs): string | null {
  const { startLine, endLine } = getContextualCopyLineRange(selection)
  const isSingleLineSelection = selection.startLineNumber === selection.endLineNumber
  if (isSingleLineSelection) {
    return null
  }

  if (endLine < startLine) {
    return null
  }

  const codeFenceLanguage = getCodeFenceLanguage(language)
  const codeBlock = selectedText.endsWith('\n') ? selectedText : `${selectedText}\n`
  const lineLabel = startLine === endLine ? `Line: ${startLine}` : `Lines: ${startLine}-${endLine}`

  return `File: ${relativePath}\n${lineLabel}\n\n\`\`\`${codeFenceLanguage}\n${codeBlock}\`\`\``
}

export function getContextualCopyLineRange(selection: IRange): {
  startLine: number
  endLine: number
} {
  return {
    startLine: selection.startLineNumber,
    endLine: getInclusiveEndLine(selection)
  }
}

export function getInclusiveEndLine(selection: IRange): number {
  if (selection.startLineNumber === selection.endLineNumber) {
    return selection.endLineNumber
  }

  // Why: Monaco reports a full-line selection as ending at column 1 of the
  // following line. We translate that boundary back to the last copied line so
  // pasted context matches what the user actually selected.
  if (selection.endColumn === 1) {
    return selection.endLineNumber - 1
  }

  return selection.endLineNumber
}

function getCodeFenceLanguage(language: string): string {
  switch (language) {
    case 'plaintext':
      return ''
    case 'typescript':
      return 'ts'
    case 'javascript':
      return 'js'
    default:
      return language
  }
}
