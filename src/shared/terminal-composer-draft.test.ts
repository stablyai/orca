import { describe, expect, it } from 'vitest'
import {
  detectTerminalComposerDraft,
  hasTerminalComposerPlaceholder
} from './terminal-composer-draft'

describe('detectTerminalComposerDraft', () => {
  // Why: ordinary tool output prints labelled rules too (`──────── build ─`), and the row
  // above a plain shell prompt is the only evidence the `❯` branch has. Regression for #16290.
  it('does not read a shell prompt under a labelled tool rule as composer input', () => {
    const shellScreen = (above: string) => ({
      rows: [above, '❯ ls'],
      typedRows: [above, '❯ ls'],
      promptGlyphBoldRows: [false, false],
      rowsBelow: [],
      typedRowsBelow: [],
      beforeCursor: '❯ ls',
      afterCursor: '',
      rawAfterCursor: '',
      cursorHidden: false,
      cursorViewportRow: 12
    })
    for (const rule of [
      '──────── build ─',
      '──────── Running tests ────────',
      '-------- coverage --------'
    ]) {
      expect(detectTerminalComposerDraft(shellScreen(rule))).toBeNull()
    }
  })

  it('accepts a Claude frame line that carries a mode label', () => {
    const frame = `${'─'.repeat(88)} ultracode ─`
    expect(
      detectTerminalComposerDraft({
        rows: [frame, '❯ Refactor the login page so that it'],
        typedRows: [frame, '❯ Refactor the login page so that it'],
        promptGlyphBoldRows: [false, false],
        rowsBelow: ['─'.repeat(100), '  ⏵⏵ auto mode on (shift+tab to cycle)'],
        typedRowsBelow: ['─'.repeat(100), ''],
        beforeCursor: '❯ Refactor the login page so that it',
        afterCursor: '',
        rawAfterCursor: '',
        cursorHidden: false,
        cursorViewportRow: 26
      })?.text
    ).toBe('Refactor the login page so that it')
    expect(
      detectTerminalComposerDraft({
        rows: ['some transcript text ending in ─', '❯ not a composer'],
        typedRows: ['some transcript text ending in ─', '❯ not a composer'],
        promptGlyphBoldRows: [false, false],
        rowsBelow: [],
        typedRowsBelow: [],
        beforeCursor: '❯ not a composer',
        afterCursor: '',
        rawAfterCursor: '',
        cursorHidden: false,
        cursorViewportRow: 1
      })
    ).toBeNull()
  })

  it('keeps a typed draft whose stock placeholder is still rendered to its right', () => {
    // Repaints can leave the placeholder beside typed text; do not mask that user draft.
    const context = {
      rows: ['\u203a \uc548\ub155Ask Codex to do anything'],
      typedRows: ['\u203a \uc548\ub155'],
      promptGlyphBoldRows: [true],
      rowsBelow: ['', 'gpt-5.6 \u00b7 ~/repo'],
      typedRowsBelow: ['', 'gpt-5.6 \u00b7 ~/repo'],
      beforeCursor: '\u203a \uc548\ub155',
      afterCursor: '',
      rawAfterCursor: 'Ask Codex to do anything',
      cursorHidden: false,
      cursorViewportRow: 4
    }

    expect(detectTerminalComposerDraft(context)).toEqual({
      text: '\uc548\ub155',
      promptRow: 4,
      cursorRow: 4,
      endRow: 4,
      promptGlyph: '\u203a'
    })
    expect(hasTerminalComposerPlaceholder(context)).toBe(false)
  })

  it('preserves a shell prompt that happens to use the Claude glyph', () => {
    expect(
      detectTerminalComposerDraft({
        rows: ['last command output', '❯ git status'],
        typedRows: ['last command output', '❯ git status'],
        promptGlyphBoldRows: [false, false],
        rowsBelow: [],
        typedRowsBelow: [],
        beforeCursor: '❯ git status',
        afterCursor: '',
        rawAfterCursor: '',
        cursorHidden: false,
        cursorViewportRow: 7
      })
    ).toBeNull()
  })

  it('rejects a hidden-cursor dialog even when its selected row uses a composer glyph', () => {
    expect(
      detectTerminalComposerDraft({
        rows: ['› 1. Yes, continue', '  Press enter to continue'],
        typedRows: ['› 1. Yes, continue', '  Press enter to continue'],
        promptGlyphBoldRows: [true, false],
        rowsBelow: [],
        typedRowsBelow: [],
        beforeCursor: '  Press enter to continue',
        afterCursor: '',
        rawAfterCursor: '',
        cursorHidden: true,
        cursorViewportRow: 5
      })
    ).toBeNull()
  })

  it('separates dimmed suggestion rows below the restored cursor', () => {
    expect(
      detectTerminalComposerDraft({
        rows: ['────────', '❯ proceed with the release'],
        typedRows: ['────────', '❯'],
        promptGlyphBoldRows: [false, false],
        rowsBelow: ['  and close the pull request', '────────'],
        typedRowsBelow: ['', '────────'],
        beforeCursor: '❯ ',
        afterCursor: '',
        rawAfterCursor: 'proceed with the release',
        cursorHidden: false,
        cursorViewportRow: 8
      })
    ).toEqual({
      text: 'proceed with the release\nand close the pull request',
      promptRow: 8,
      cursorRow: 8,
      endRow: 9,
      promptGlyph: '❯'
    })
  })

  it('recognizes a Codex composer with an arbitrary dimmed thread-title footer', () => {
    expect(
      detectTerminalComposerDraft({
        rows: ['› review the change'],
        typedRows: ['› review the change'],
        promptGlyphBoldRows: [true],
        rowsBelow: ['', '  Release train'],
        typedRowsBelow: ['', ''],
        rowsBelowWrapped: [false, false],
        beforeCursor: '› review the change',
        afterCursor: '',
        rawAfterCursor: '',
        cursorHidden: false,
        cursorViewportRow: 4
      })
    ).toMatchObject({ text: 'review the change', promptGlyph: '›' })
  })

  it('preserves an ordinary shell prompt that uses the Codex glyph', () => {
    const context = {
      rows: ['last command output', '› git status'],
      typedRows: ['last command output', '› git status'],
      promptGlyphBoldRows: [false, true],
      rowsBelow: [],
      typedRowsBelow: [],
      beforeCursor: '› git status',
      afterCursor: '',
      rawAfterCursor: '',
      cursorHidden: false,
      cursorViewportRow: 7
    }

    expect(detectTerminalComposerDraft(context)).toBeNull()
    expect(hasTerminalComposerPlaceholder(context)).toBe(false)
  })

  it('keeps a wrapped stock placeholder out of draft metadata', () => {
    expect(
      detectTerminalComposerDraft({
        rows: ['› Ask Codex to do'],
        typedRows: ['›'],
        promptGlyphBoldRows: [true],
        rowsBelow: ['  anything'],
        typedRowsBelow: [''],
        beforeCursor: '› ',
        afterCursor: '',
        rawAfterCursor: 'Ask Codex to do',
        cursorHidden: false,
        cursorViewportRow: 4
      })
    ).toBeNull()
  })

  it('keeps a draft continuation containing a middle dot', () => {
    expect(
      detectTerminalComposerDraft({
        rows: ['────────', '❯ proceed '],
        typedRows: ['────────', '❯'],
        promptGlyphBoldRows: [false, false],
        rowsWrapped: [false, false],
        rowsBelow: ['deploy · verify', '────────'],
        typedRowsBelow: ['', '────────'],
        rowsBelowWrapped: [true, false],
        beforeCursor: '❯ ',
        afterCursor: 'proceed ',
        rawAfterCursor: 'proceed ',
        cursorHidden: false,
        cursorViewportRow: 8
      })?.text
    ).toBe('proceed deploy · verify')
  })

  it('keeps a model-like continuation before the Codex status footer', () => {
    expect(
      detectTerminalComposerDraft({
        rows: ['› compare '],
        typedRows: ['› compare '],
        promptGlyphBoldRows: [true],
        rowsBelow: ['gpt-5 · verify', 'gpt-5.6 · Context 12% used'],
        typedRowsBelow: ['gpt-5 · verify', 'gpt-5.6 · Context 12% used'],
        rowsBelowWrapped: [false, false],
        beforeCursor: '› compare ',
        afterCursor: '',
        rawAfterCursor: '',
        cursorHidden: false,
        cursorViewportRow: 4
      })?.text
    ).toBe('compare\ngpt-5 · verify')
  })

  it('keeps typed soft-wrapped rows below a restored cursor in the draft', () => {
    expect(
      detectTerminalComposerDraft({
        rows: ['────────', '❯ proceed with the '],
        typedRows: ['────────', '❯ proceed with the '],
        promptGlyphBoldRows: [false, false],
        rowsWrapped: [false, false],
        rowsBelow: ['release'],
        typedRowsBelow: ['release'],
        rowsBelowWrapped: [true],
        beforeCursor: '❯ proceed',
        afterCursor: ' with the ',
        rawAfterCursor: ' with the ',
        cursorHidden: false,
        cursorViewportRow: 8
      })?.text
    ).toBe('proceed with the release')
  })

  it('keeps typed hard-newline rows below a restored cursor in the draft', () => {
    expect(
      detectTerminalComposerDraft({
        rows: ['────────', '❯ first line'],
        typedRows: ['────────', '❯ first line'],
        promptGlyphBoldRows: [false, false],
        rowsWrapped: [false, false],
        rowsBelow: ['  second line', '────────'],
        typedRowsBelow: ['  second line', '────────'],
        rowsBelowWrapped: [false, false],
        beforeCursor: '❯ first',
        afterCursor: ' line',
        rawAfterCursor: ' line',
        cursorHidden: false,
        cursorViewportRow: 8
      })?.text
    ).toBe('first line\nsecond line')
  })

  it('keeps typed continuation rows after an intentional blank draft line', () => {
    expect(
      detectTerminalComposerDraft({
        rows: ['────────', '❯ first line'],
        typedRows: ['────────', '❯ first line'],
        promptGlyphBoldRows: [false, false],
        rowsWrapped: [false, false],
        rowsBelow: ['', '  second line', '────────'],
        typedRowsBelow: ['', '  second line', '────────'],
        rowsBelowWrapped: [false, false, false],
        beforeCursor: '❯ first',
        afterCursor: ' line',
        rawAfterCursor: ' line',
        cursorHidden: false,
        cursorViewportRow: 8
      })
    ).toMatchObject({ text: 'first line\n\nsecond line', endRow: 10 })
  })

  // Why: the mode-label tolerance belongs to the top rule alone. A draft row that opens with
  // rule characters (`-------- coverage --------`) would otherwise read as the bottom border
  // and silently truncate the draft, so the refusal reports only part of what the user typed.
  it('keeps a draft continuation row that looks like a labelled rule', () => {
    expect(
      detectTerminalComposerDraft({
        rows: ['\u2500'.repeat(8), '\u276F first line'],
        typedRows: ['\u2500'.repeat(8), '\u276F first line'],
        promptGlyphBoldRows: [false, false],
        rowsWrapped: [false, false],
        rowsBelow: ['-------- coverage --------', '  third line', '\u2500'.repeat(8)],
        typedRowsBelow: ['-------- coverage --------', '  third line', '\u2500'.repeat(8)],
        rowsBelowWrapped: [false, false, false],
        beforeCursor: '\u276F first',
        afterCursor: ' line',
        rawAfterCursor: ' line',
        cursorHidden: false,
        cursorViewportRow: 8
      })?.text
    ).toBe('first line\n-------- coverage --------\nthird line')
  })

  it('keeps a model-like Claude paragraph above the bottom composer frame', () => {
    expect(
      detectTerminalComposerDraft({
        rows: ['────────', '❯ compare models'],
        typedRows: ['────────', '❯ compare models'],
        promptGlyphBoldRows: [false, false],
        rowsWrapped: [false, false],
        rowsBelow: ['', 'gpt-5 · verify', '────────'],
        typedRowsBelow: ['', 'gpt-5 · verify', '────────'],
        rowsBelowWrapped: [false, false, false],
        beforeCursor: '❯ ',
        afterCursor: 'compare models',
        rawAfterCursor: 'compare models',
        cursorHidden: false,
        cursorViewportRow: 8
      })?.text
    ).toBe('compare models\n\ngpt-5 · verify')
  })

  it('stops before a blank row that only precedes the composer frame', () => {
    expect(
      detectTerminalComposerDraft({
        rows: ['────────', '❯ first line'],
        typedRows: ['────────', '❯ first line'],
        promptGlyphBoldRows: [false, false],
        rowsBelow: ['', '────────'],
        typedRowsBelow: ['', '────────'],
        beforeCursor: '❯ first line',
        afterCursor: '',
        rawAfterCursor: '',
        cursorHidden: false,
        cursorViewportRow: 8
      })
    ).toMatchObject({ text: 'first line', endRow: 8 })
  })
})
