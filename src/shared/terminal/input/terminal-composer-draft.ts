import { isStockPlaceholder } from './terminal-composer-stock-placeholder'

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
  /** Read only while the native cursor is hidden; absent means unknown. */
  activeBuffer?: 'normal' | 'alternate'
  cursorInverse?: boolean
}

export type TerminalComposerDraft = {
  text: string
  promptRow: number
  cursorRow: number
  endRow: number
  promptGlyph: '❯' | '›' | '»'
}

type TerminalComposerMatch = TerminalComposerDraft & { placeholder: boolean }

const COMPOSER_PROMPT_PREFIX = /^\s*[\u276F\u203A\u00BB]\s?/
const COMPOSER_FRAME_LINE = /^[\u2500\u2501-]{8,}\s*$/
const COMPOSER_TOP_FRAME_PREFIX = /^[\u2500\u2501-]{8,}/
// Codex can follow the model with reasoning effort and service tier (`gpt-5.4 high Fast`).
const CODEX_FOOTER_LINE = /^\s*(?:gpt-\S+|o\d\S*)(?:\s+[\w-]+){0,2}\s+[\u00B7\u2022]\s+\S.*$/i
// Startup and tall composers can leave just the undimmed shortcut hint or warning counter.
const CODEX_COMPACT_FOOTER_LINE =
  /^\s*(?:\? for shortcuts|\u26A0\s+\d+ warnings? \u00B7 f2 to view)\s*$/

function composerContinuationRows(
  context: TerminalCursorContext,
  afterCursor: string,
  codexFooterIndex: number,
  typedOnly: boolean
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
    const typed = context.typedRowsBelow[index] ?? ''
    if (!(typedOnly ? typed : raw).trim() && !hasTypedContinuationAfter[index]) {
      break
    }
    continuation.push({
      text: typed.trim() || typedOnly ? typed : raw,
      wrapped: context.rowsBelowWrapped?.[index] ?? false
    })
  }
  return continuation
}

function hasFooterGap(context: TerminalCursorContext, index: number): boolean {
  return index > 0 && !(context.rowsBelow[index - 1] ?? '').trim()
}

function isCodexFooterRow(context: TerminalCursorContext, index: number): boolean {
  const row = context.rowsBelow[index] ?? ''
  const undimmed = context.typedRowsBelow[index] ?? ''
  const gap = hasFooterGap(context, index)
  const isDimmedFooter = gap && !undimmed.trim() && context.rowsBelowWrapped?.[index] === false
  const isColoredFooter =
    gap &&
    context.rowsBelowCustomForeground?.[index] === true &&
    context.rowsBelowWrapped?.[index] === false
  return (
    isDimmedFooter ||
    isColoredFooter ||
    CODEX_FOOTER_LINE.test(row) ||
    (gap && CODEX_COMPACT_FOOTER_LINE.test(row))
  )
}

function findCodexFooterIndex(context: TerminalCursorContext): number {
  const last = context.rowsBelow.findLastIndex((row) => row.trim())
  if (last === -1 || isCodexFooterRow(context, last)) {
    return last
  }
  // Why: Codex's separate status line keeps its hint row (`? for shortcuts`) directly below it.
  const status = last - 1
  if (
    COMPOSER_FRAME_LINE.test(context.rowsBelow[last] ?? '') ||
    !(context.rowsBelow[status] ?? '').trim() ||
    !hasFooterGap(context, status)
  ) {
    return -1
  }
  return isCodexFooterRow(context, status) ? status : -1
}

// Why: Claude's default caret hides the native cursor and parks it at a painted caret cell. That paint
// drops on focus-out, so it is required only where another program's alternate-screen frame could
// mimic the box; a complete frame with the cursor inside is always required.
function isHiddenComposerCaret(
  context: TerminalCursorContext,
  cursorOnPromptRow: boolean,
  closedByFrame: boolean
): boolean {
  return (
    closedByFrame &&
    (!cursorOnPromptRow || /^\s*\u276F/.test(context.beforeCursor)) &&
    (context.activeBuffer === 'normal' || context.cursorInverse === true)
  )
}

// Why: Claude paints its caret over a suggestion's first glyph undimmed and dims the rest (#40195).
function isCaretOverDimSuggestion(context: TerminalCursorContext): boolean {
  const painted = context.afterCursor
  const raw = context.rawAfterCursor
  return (
    context.cursorInverse === true &&
    [...painted].length === 1 &&
    raw.length > painted.length &&
    raw.startsWith(painted) &&
    // Why: on a typed word's last glyph the caret sits before a dim hint and the glyph is real.
    (!context.beforeCursor.replace(COMPOSER_PROMPT_PREFIX, '').trim() ||
      !/\s/.test(raw[painted.length] ?? ''))
  )
}

function detectTerminalComposer(
  context: TerminalCursorContext | null | undefined,
  typedOnly = false,
  allowClippedCodex = false
): TerminalComposerMatch | null {
  if (!context || context.rows.length === 0) {
    return null
  }
  const cursorIndex = context.rows.length - 1
  const codexFooterIndex = findCodexFooterIndex(context)
  const typedAfter = isCaretOverDimSuggestion(context) ? '' : context.afterCursor
  let afterCursor = typedOnly ? typedAfter : typedAfter || context.rawAfterCursor
  let continuationRows = composerContinuationRows(context, afterCursor, codexFooterIndex, typedOnly)
  // Why: the continuation walk stops at the row that would close the frame; typed-only walks also
  // stop at dim suggestion rows, which still sit inside the frame.
  let frameIndex = continuationRows.length
  while (
    typedOnly &&
    (context.rowsBelow[frameIndex] ?? '').trim() &&
    !(context.typedRowsBelow[frameIndex] ?? '').trim() &&
    !COMPOSER_FRAME_LINE.test(context.rowsBelow[frameIndex] ?? '')
  ) {
    frameIndex += 1
  }
  const closedByFrame = COMPOSER_FRAME_LINE.test(context.rowsBelow[frameIndex] ?? '')
  // Typed-only reads already drop dim placeholders; undimmed text that matches one is the user's.
  const placeholder = !typedOnly && isStockPlaceholder(afterCursor, continuationRows)
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
      if (glyph === '❯') {
        const top = context.rows[index - 1] ?? ''
        if (
          (!COMPOSER_FRAME_LINE.test(top) &&
            (!COMPOSER_TOP_FRAME_PREFIX.test(top.trimStart()) || !closedByFrame)) ||
          (context.cursorHidden &&
            !isHiddenComposerCaret(context, index === cursorIndex, closedByFrame))
        ) {
          return null
        }
      } else if (
        context.cursorHidden ||
        context.promptGlyphBoldRows[index] !== true ||
        (codexFooterIndex === -1 && !(allowClippedCodex && glyph === '›'))
      ) {
        return null
      }
      const lines: { text: string; wrapped: boolean }[] =
        index === cursorIndex
          ? [
              { text: cursorText.replace(COMPOSER_PROMPT_PREFIX, ''), wrapped: false },
              ...continuationRows
            ]
          : [
              {
                text: (context.typedRows[index] ?? row).replace(COMPOSER_PROMPT_PREFIX, ''),
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
      // The agent pads continuation rows to the width of its prompt; deeper indentation is the user's.
      const layoutPadding = typedOnly ? (row.match(COMPOSER_PROMPT_PREFIX)?.[0].length ?? 0) : 0
      const text = lines
        .map((line, lineIndex) => {
          const continuesPrevious = lineIndex > 0 && line.wrapped
          const continuesNext = lines[lineIndex + 1]?.wrapped ?? false
          const start = continuesPrevious ? '' : lineIndex > 0 ? '\n' : ''
          const content = continuesPrevious
            ? line.text
            : typedOnly && lineIndex > 0
              ? line.text.slice(Math.min(layoutPadding, line.text.search(/\S|$/)))
              : line.text.trimStart()
          return `${start}${continuesNext ? content : content.trimEnd()}`
        })
        .join('')
        .trim()
      if (!text && !placeholder && !typedOnly) {
        return null
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

/** The user's own text in the composer, '' when it holds only a placeholder or a dim suggestion, null when no composer is visible. */
export function readTerminalComposerTypedText(
  context: TerminalCursorContext | null | undefined
): string | null {
  const boxed = context ? detectBoxedComposerDraft(context) : null
  return boxed ? boxed.text : (detectTerminalComposer(context, true)?.text ?? null)
}

/** Only for a caller-owned paste: a tall Codex composer can scroll its footer out of view. */
export function readClippedCodexComposerDraft(
  context: TerminalCursorContext | null
): string | null {
  if (!context || context.rowsBelow.some((row) => row.trim())) {
    return null
  }
  return detectTerminalComposer(context, true, true)?.text ?? null
}

/** True when a verified composer paints only a placeholder, suggestion or dim hint right of its cursor. */
export function hasTerminalComposerPlaceholder(
  context: TerminalCursorContext | null | undefined
): boolean {
  if (!context?.rawAfterCursor.trim()) {
    return false
  }
  // Why: the IME overlay redraws the row from the cursor without cell attributes, so a dim tail turns white.
  const onlyDimAfterCursor = !context.afterCursor.trim() || isCaretOverDimSuggestion(context)
  return (
    (onlyDimAfterCursor && readTerminalComposerTypedText(context) !== null) ||
    detectTerminalComposer(context)?.placeholder === true
  )
}
