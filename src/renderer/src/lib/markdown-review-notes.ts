import type { DiffComment } from '../../../shared/types'
import { getDiffCommentLineLabel } from './diff-comment-compat'

const MAX_EXCERPT_LINES = 8
const MAX_CARD_QUOTE_LENGTH = 60

export type MarkdownReviewNote = DiffComment & { source: 'markdown' }

export function sortMarkdownReviewNotes(
  notes: readonly MarkdownReviewNote[]
): MarkdownReviewNote[] {
  return [...notes].sort((a, b) => {
    const pathCompare = a.filePath.localeCompare(b.filePath)
    if (pathCompare !== 0) {
      return pathCompare
    }
    const startA = a.startLine ?? a.lineNumber
    const startB = b.startLine ?? b.lineNumber
    if (startA !== startB) {
      return startA - startB
    }
    if (a.lineNumber !== b.lineNumber) {
      return a.lineNumber - b.lineNumber
    }
    return a.createdAt - b.createdAt
  })
}

export function getMarkdownReviewExcerpt(
  content: string,
  note: Pick<DiffComment, 'lineNumber' | 'startLine'>
): string {
  const startLine = Math.max(1, note.startLine ?? note.lineNumber)
  const endLine = Math.max(startLine, note.lineNumber)
  const selected = getMarkdownReviewSelectedLines(content, startLine, endLine)
  if (selected.count === 0) {
    return ''
  }

  const excerpt =
    selected.count <= MAX_EXCERPT_LINES
      ? selected.lines
      : [...selected.headLines, '...', ...selected.tailLines]

  return excerpt.map((line) => `> ${line}`).join('\n')
}

function getMarkdownReviewSelectedLines(
  content: string,
  startLine: number,
  endLine: number
): {
  count: number
  lines: string[]
  headLines: string[]
  tailLines: string[]
} {
  const headLimit = Math.ceil(MAX_EXCERPT_LINES / 2)
  const tailLimit = Math.floor(MAX_EXCERPT_LINES / 2)
  const lines: string[] = []
  const tailLines: string[] = []
  let count = 0

  forEachMarkdownReviewLine(content, (line, lineNumber) => {
    if (lineNumber < startLine) {
      return
    }
    if (lineNumber > endLine) {
      return false
    }
    count += 1
    if (count <= MAX_EXCERPT_LINES) {
      lines.push(line)
      return lineNumber >= endLine ? false : undefined
    }
    if (count === MAX_EXCERPT_LINES + 1) {
      tailLines.push(...lines.slice(-(tailLimit - 1)), line)
      return lineNumber >= endLine ? false : undefined
    }
    tailLines.push(line)
    if (tailLines.length > tailLimit) {
      tailLines.shift()
    }
    return lineNumber >= endLine ? false : undefined
  })

  return { count, lines, headLines: lines.slice(0, headLimit), tailLines }
}

function forEachMarkdownReviewLine(
  content: string,
  visit: (line: string, lineNumber: number) => boolean | void
): void {
  let lineStart = 0
  let lineNumber = 1
  for (let index = 0; index <= content.length; index += 1) {
    if (index < content.length && content.charCodeAt(index) !== 10) {
      continue
    }
    const lineEnd = index > lineStart && content.charCodeAt(index - 1) === 13 ? index - 1 : index
    if (visit(content.slice(lineStart, lineEnd), lineNumber) === false) {
      return
    }
    lineStart = index + 1
    lineNumber += 1
  }
}

export function getMarkdownReviewHighlightedText(
  content: string,
  note: Pick<DiffComment, 'lineNumber' | 'selectedText' | 'startLine'>
): string {
  const selectedText = note.selectedText?.trim()
  if (selectedText) {
    return selectedText
  }
  const excerpt = getMarkdownReviewExcerpt(content, note)
  return excerpt.replace(/^> ?/gm, '').trim()
}

export function formatMarkdownReviewCardQuote(text: string | null | undefined): string | undefined {
  if (text === null || text === undefined) {
    return undefined
  }
  return formatBoundedMarkdownReviewCardQuote(text)
}

// Why: selected review text can come from large pasted markdown; card quotes
// only need a short preview, not a fully normalized copy of the selection.
function formatBoundedMarkdownReviewCardQuote(text: string): string | undefined {
  let normalized = ''
  let pendingWhitespace = false
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (isMarkdownReviewCardQuoteWhitespace(code)) {
      pendingWhitespace = normalized.length > 0
      continue
    }
    if (pendingWhitespace) {
      normalized += ' '
      pendingWhitespace = false
    }
    normalized += text.charAt(index)
    if (normalized.length > MAX_CARD_QUOTE_LENGTH) {
      return `${normalized.slice(0, MAX_CARD_QUOTE_LENGTH - 3).trimEnd()}...`
    }
  }
  return normalized.length > 0 ? normalized : undefined
}

function isMarkdownReviewCardQuoteWhitespace(code: number): boolean {
  return (
    code === 32 ||
    (code >= 9 && code <= 13) ||
    code === 160 ||
    code === 5760 ||
    (code >= 8192 && code <= 8202) ||
    code === 8232 ||
    code === 8233 ||
    code === 8239 ||
    code === 8287 ||
    code === 12288 ||
    code === 65279
  )
}

export function getMarkdownReviewCardQuote(
  content: string,
  note: Pick<DiffComment, 'lineNumber' | 'selectedText' | 'startLine'>
): string | undefined {
  return formatMarkdownReviewCardQuote(getMarkdownReviewHighlightedText(content, note))
}

function escapeMarkdownReviewNoteBody(body: string): string {
  return body
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
}

function formatMarkdownReviewNoteDetails(note: MarkdownReviewNote, content: string): string {
  const excerpt = note.selectedText
    ? quoteMarkdownReviewText(getMarkdownReviewHighlightedText(content, note))
    : getMarkdownReviewExcerpt(content, note)
  const parts = [
    getDiffCommentLineLabel(note),
    excerpt ? `Excerpt:\n${excerpt}` : null,
    `User comment: "${escapeMarkdownReviewNoteBody(note.body)}"`
  ]
  return parts.filter((part): part is string => part !== null).join('\n')
}

function quoteMarkdownReviewText(text: string): string {
  return `> ${text.replace(/\r\n|\r|\n/g, '\n> ')}`
}

export function formatMarkdownReviewNotes(
  notes: readonly MarkdownReviewNote[],
  content: string
): string {
  const groups = new Map<string, MarkdownReviewNote[]>()
  for (const note of sortMarkdownReviewNotes(notes)) {
    const group = groups.get(note.filePath)
    if (group) {
      group.push(note)
    } else {
      groups.set(note.filePath, [note])
    }
  }

  return [...groups.entries()]
    .map(([filePath, fileNotes]) => {
      // Why: agents need the file once; repeated markdown note blocks waste prompt context.
      return [
        `File: ${filePath}`,
        'Source: markdown',
        '',
        fileNotes.map((note) => formatMarkdownReviewNoteDetails(note, content)).join('\n\n')
      ].join('\n')
    })
    .join('\n\n')
}
