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

const COMPOSER_FRAME_LINE = /^[\u2500\u2501-]{8,}\s*$/
const CODEX_FOOTER_LINE = /^\s*(?:gpt-\S+|o\d\S*)\s+[\u00B7\u2022]\s+\S.*$/i

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
  for (let index = context.rowsBelow.length - 1; index >= 0; index -= 1) {
    const row = context.rowsBelow[index] ?? ''
    if (!row.trim()) {
      continue
    }
    const undimmed = context.typedRowsBelow[index] ?? ''
    const hasFooterGap = index > 0 && !(context.rowsBelow[index - 1] ?? '').trim()
    const isDimmedFooter =
      hasFooterGap && !undimmed.trim() && context.rowsBelowWrapped?.[index] === false
    const isColoredFooter =
      hasFooterGap &&
      context.rowsBelowCustomForeground?.[index] === true &&
      context.rowsBelowWrapped?.[index] === false
    return isDimmedFooter || isColoredFooter || CODEX_FOOTER_LINE.test(row) ? index : -1
  }
  return -1
}

// Codex before 0.152 rotated these (codex-rs/tui/src/chatwidget.rs PLACEHOLDERS, SIDE_PLACEHOLDERS).
const STOCK_PLACEHOLDERS: ReadonlySet<string> = new Set([
  'Ask Codex to do anything',
  'Ask a follow-up question',
  'Explain this codebase',
  'Summarize recent commits',
  'Implement {feature}',
  'Find and fix a bug in @filename',
  'Write tests for @filename',
  'Improve documentation in @filename',
  'Run /review on my current changes',
  'Use /skills to list available skills',
  'Check recently modified functions for compatibility',
  'How many files have been modified?',
  'Will this algorithm scale well?'
])

function isStockPlaceholder(
  afterCursor: string,
  continuationRows: { text: string; wrapped: boolean }[]
): boolean {
  const text = [afterCursor, ...continuationRows.map((row) => row.text)]
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  return /^Try\s+["\u201C]/.test(text) || STOCK_PLACEHOLDERS.has(text)
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
    const matched = row.match(/^\s*([\u276F\u203A\u00BB])/)?.[1]
    const glyph = (['❯', '›', '»'] as const).find((candidate) => candidate === matched)
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
          ? [
              { text: cursorText.replace(/^\s*[\u276F\u203A\u00BB]\s?/, ''), wrapped: false },
              ...continuationRows
            ]
          : [
              {
                text: (context.typedRows[index] ?? row).replace(/^\s*[\u276F\u203A\u00BB]\s?/, ''),
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

// Why: dsh-tui 0.17 boxes its single-line launchpad composer (`│ ❯ draft │`) under a `╭─╮` top.
// Why String.raw: the orcad bundle must stay ASCII, and the formatter unescapes regex literals.
const BOXED_COMPOSER_TOP = new RegExp(String.raw`^\s*\u256D\u2500{8,}\u256E\s*$`)
const BOXED_COMPOSER_ROW = new RegExp(String.raw`^\s*\u2502 \u276F `)
const BOXED_COMPOSER_RIGHT_EDGE = new RegExp(String.raw`\u2502\s*$`)

function detectBoxedComposerDraft(context: TerminalCursorContext): TerminalComposerDraft | null {
  const cursorIndex = context.rows.length - 1
  if (
    context.cursorHidden ||
    !BOXED_COMPOSER_ROW.test(context.rows[cursorIndex] ?? '') ||
    !BOXED_COMPOSER_TOP.test(context.rows[cursorIndex - 1] ?? '')
  ) {
    return null
  }
  // Why left of the cursor: the empty launchpad paints its placeholder, undimmed, right of it.
  const typed = context.beforeCursor.replace(BOXED_COMPOSER_ROW, '')
  if (!typed.trim()) {
    return null
  }
  const text = `${typed}${context.afterCursor.replace(BOXED_COMPOSER_RIGHT_EDGE, '')}`.trim()
  const row = context.cursorViewportRow
  return { text, promptRow: row, cursorRow: row, endRow: row, promptGlyph: '❯' }
}

export function detectTerminalComposerDraft(
  context: TerminalCursorContext | null | undefined
): TerminalComposerDraft | null {
  const boxed = context ? detectBoxedComposerDraft(context) : null
  if (boxed) {
    return boxed
  }
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
