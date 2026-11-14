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
  if (!canCopySelectionWithContext(selection)) {
    return null
  }
  const { startLine, endLine } = getContextualCopyLineRange(selection)

  const codeFenceLanguage = getCodeFenceLanguage(language)
  const codeBlock = selectedText.endsWith('\n') ? selectedText : `${selectedText}\n`
  const lineLabel = startLine === endLine ? `Line: ${startLine}` : `Lines: ${startLine}-${endLine}`

  return `File: ${relativePath}\n${lineLabel}\n\n\`\`\`${codeFenceLanguage}\n${codeBlock}\`\`\``
}

/** `path:start-end` and the lines in a code block, as a chat quote names a file selection. */
export function formatSelectionReference({
  relativePath,
  language,
  selection,
  selectedText
}: FormatCopiedSelectionArgs): string {
  const { startLine, endLine } = getContextualCopyLineRange(selection)
  const range = startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`
  return `${relativePath}:${range}\n${fencedCode(selectedText, getCodeFenceLanguage(language))}`
}

/** A fence longer than any backtick run in the text, so the text can't close it. */
export function fencedCode(text: string, language = ''): string {
  let longest = 0
  for (const run of text.matchAll(/`+/g)) {
    longest = Math.max(longest, run[0].length)
  }
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}${language}\n${text.replace(/\n$/, '')}\n${fence}`
}

export function canCopySelectionWithContext(selection: IRange): boolean {
  return (
    selection.startLineNumber !== selection.endLineNumber &&
    getInclusiveEndLine(selection) >= selection.startLineNumber
  )
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

export function getRemoteUrlLineRange(
  line: number,
  selection: IRange | null
): { line: number; endLine?: number } {
  if (selection) {
    const { startLine, endLine } = getContextualCopyLineRange(selection)
    if (endLine > startLine && line >= startLine && line <= endLine) {
      return { line: startLine, endLine }
    }
  }
  return { line }
}

export function getInclusiveEndLine(selection: IRange): number {
  if (selection.startLineNumber === selection.endLineNumber) {
    return selection.endLineNumber
  }

  // Monaco’s full-line selection ends at the next line’s column 1; report the last line actually copied.
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
