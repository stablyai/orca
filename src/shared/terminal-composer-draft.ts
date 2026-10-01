export type TerminalCursorContext = {
  rows: string[]
  typedRows: string[]
  promptGlyphBoldRows: boolean[]
  rowsWrapped?: boolean[]
  rowsBelow: string[]
  typedRowsBelow: string[]
  rowsBelowWrapped?: boolean[]
  rowsBelowCustomForeground?: boolean[]
  beforeCursor: string
  afterCursor: string
  rawAfterCursor: string
  cursorHidden: boolean
  cursorViewportRow: number
}

export type TerminalComposerDraft = {
  text: string
  promptRow: number
  cursorRow: number
  endRow: number
  promptGlyph: '❯' | '›' | '»'
}

type TerminalComposerMatch = TerminalComposerDraft & { placeholder: boolean }

const COMPOSER_FRAME_LINE = /^[─━-]{8,}\s*$/
const CODEX_FOOTER_LINE = /^\s*(?:gpt-\S+|o\d\S*)\s+[·•]\s+\S.*$/i

function composerContinuationRows(
  context: TerminalCursorContext,
  afterCursor: string,
  codexFooterIndex: number
): { text: string; wrapped: boolean }[] {
  if (!afterCursor.trim() && !context.typedRowsBelow.some((row) => row.trim())) {
    return []
  }
  const continuation: { text: string; wrapped: boolean }[] = []
  const hasTypedContinuationAfter = context.rowsBelow.map(() => false)
  let hasFollowingTyped = false
  for (let index = context.rowsBelow.length - 1; index >= 0; index -= 1) {
    const raw = context.rowsBelow[index] ?? ''
    if (COMPOSER_FRAME_LINE.test(raw) || index === codexFooterIndex) {
      hasFollowingTyped = false
      continue
    }
    hasTypedContinuationAfter[index] = hasFollowingTyped
    if ((context.typedRowsBelow[index] ?? '').trim()) {
      hasFollowingTyped = true
    }
  }
  for (let index = 0; index < context.rowsBelow.length; index += 1) {
    const raw = context.rowsBelow[index] ?? ''
    if (COMPOSER_FRAME_LINE.test(raw) || index === codexFooterIndex) {
      break
    }
    if (!raw.trim() && !hasTypedContinuationAfter[index]) {
      break
    }
    const typed = context.typedRowsBelow[index] ?? ''
    continuation.push({
      text: typed.trim() ? typed : raw,
      wrapped: context.rowsBelowWrapped?.[index] ?? false
    })
  }
  return continuation
}

function findCodexFooterIndex(context: TerminalCursorContext): number {
  let end = context.rowsBelow.length - 1
  while (end >= 0 && !(context.rowsBelow[end] ?? '').trim()) {
    end -= 1
  }
  if (end < 0) {
    return -1
  }
  let start = end
  while (start > 0 && (context.rowsBelow[start - 1] ?? '').trim()) {
    start -= 1
  }
  // A footer is a separate bottom block; help rows belong to the same block as its status row.
  const hasFooterGap = start > 0 && !(context.rowsBelow[start - 1] ?? '').trim()
  const isStyledStatus =
    !(context.typedRowsBelow[start] ?? '').trim() ||
    context.rowsBelowCustomForeground?.[start] === true
  if (hasFooterGap && context.rowsBelowWrapped?.[start] === false && isStyledStatus) {
    return start
  }
  return CODEX_FOOTER_LINE.test(context.rowsBelow[end] ?? '') ? end : -1
}

function isStockPlaceholder(
  afterCursor: string,
  continuationRows: { text: string; wrapped: boolean }[]
): boolean {
  const text = [afterCursor, ...continuationRows.map((row) => row.text)]
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  return (
    /^Try\s+["“]/.test(text) ||
    text === 'Ask Codex to do anything' ||
    text === 'Ask a follow-up question'
  )
}

function detectTerminalComposer(
  context: TerminalCursorContext | null | undefined
): TerminalComposerMatch | null {
  if (!context || context.cursorHidden || context.rows.length === 0) {
    return null
  }
  const cursorIndex = context.rows.length - 1
  const codexFooterIndex = findCodexFooterIndex(context)
  let afterCursor = context.afterCursor || context.rawAfterCursor
  let continuationRows = composerContinuationRows(context, afterCursor, codexFooterIndex)
  const placeholder = isStockPlaceholder(afterCursor, continuationRows)
  if (placeholder) {
    afterCursor = ''
    continuationRows = []
  }
  const cursorText = `${context.beforeCursor}${afterCursor}`
  for (let index = cursorIndex; index >= 0; index -= 1) {
    const row = context.rows[index] ?? ''
    const glyph = row.match(/^\s*([❯›»])/)?.[1] as '❯' | '›' | '»' | undefined
    if (glyph) {
      if (glyph === '❯' && !COMPOSER_FRAME_LINE.test(context.rows[index - 1] ?? '')) {
        return null
      }
      if (
        (glyph === '›' || glyph === '»') &&
        (context.promptGlyphBoldRows[index] !== true || codexFooterIndex === -1)
      ) {
        return null
      }
      const lines: { text: string; wrapped: boolean }[] =
        index === cursorIndex
          ? [{ text: cursorText.replace(/^\s*[❯›»]\s?/, ''), wrapped: false }, ...continuationRows]
          : [
              {
                text: (context.typedRows[index] ?? row).replace(/^\s*[❯›»]\s?/, ''),
                wrapped: false
              },
              ...context.typedRows.slice(index + 1, cursorIndex).map((text, offset) => ({
                text,
                wrapped: context.rowsWrapped?.[index + 1 + offset] ?? false
              })),
              {
                text: cursorText,
                wrapped: context.rowsWrapped?.[cursorIndex] ?? false
              },
              ...continuationRows
            ]
      const text = lines
        .map((line, lineIndex) => {
          const continuesPrevious = lineIndex > 0 && line.wrapped
          const continuesNext = lines[lineIndex + 1]?.wrapped ?? false
          const start = continuesPrevious ? '' : lineIndex > 0 ? '\n' : ''
          const content = continuesPrevious ? line.text : line.text.trimStart()
          return `${start}${continuesNext ? content : content.trimEnd()}`
        })
        .join('')
        .trim()
      if (!text) {
        if (!placeholder) {
          return null
        }
      }
      return {
        text,
        promptRow: context.cursorViewportRow - (cursorIndex - index),
        cursorRow: context.cursorViewportRow,
        endRow: context.cursorViewportRow + continuationRows.length,
        promptGlyph: glyph,
        placeholder: !text && placeholder
      }
    }
    if (row.length > 0 && context.rowsWrapped?.[index] !== true && !/^\s/.test(row)) {
      return null
    }
  }
  return null
}

export function detectTerminalComposerDraft(
  context: TerminalCursorContext | null | undefined
): TerminalComposerDraft | null {
  const match = detectTerminalComposer(context)
  if (!match || match.placeholder) {
    return null
  }
  return {
    text: match.text,
    promptRow: match.promptRow,
    cursorRow: match.cursorRow,
    endRow: match.endRow,
    promptGlyph: match.promptGlyph
  }
}

export function hasTerminalComposerPlaceholder(
  context: TerminalCursorContext | null | undefined
): boolean {
  return detectTerminalComposer(context)?.placeholder === true
}
