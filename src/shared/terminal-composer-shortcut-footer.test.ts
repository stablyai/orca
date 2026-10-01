import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Terminal } from '@xterm/headless'
import { describe, expect, it } from 'vitest'
import {
  detectTerminalComposerDraft,
  hasTerminalComposerPlaceholder
} from './terminal-composer-draft'
import { readTerminalCursorLineContext } from './terminal-cursor-line-context'

describe('Codex composer with trailing shortcut help', () => {
  it('recognizes the placeholder in the captured Codex 0.157.1 screen', async () => {
    const terminal = new Terminal({ cols: 120, rows: 40, allowProposedApi: true })
    try {
      const transcript = readFileSync(
        join(__dirname, '../main/runtime/__fixtures__/codex-0157-plain-ready.txt'),
        'utf8'
      )
      await new Promise<void>((resolve) => terminal.write(transcript, resolve))
      const context = readTerminalCursorLineContext(terminal, terminal.rows)
      expect(context?.rowsBelow).toEqual([
        '',
        expect.stringContaining('GPT-6-Sol medium'),
        '  ← for agents · ? for shortcuts'
      ])
      expect(hasTerminalComposerPlaceholder(context)).toBe(true)
      expect(detectTerminalComposerDraft(context)).toBeNull()

      await new Promise<void>((resolve) => terminal.write('\x1b[Kreview this', resolve))
      const draft = readTerminalCursorLineContext(terminal, terminal.rows)
      expect(hasTerminalComposerPlaceholder(draft)).toBe(false)
      expect(detectTerminalComposerDraft(draft)?.text).toBe('review this')
    } finally {
      terminal.dispose()
    }
  })

  it.each([
    ['shortcut help without a status row', ['', '  ? for shortcuts'], [false, false]],
    ['ordinary trailing output', ['', 'gpt-5.6 · ~/repo', 'output'], [false, false, false]],
    [
      'wrapped draft resembling help',
      ['', 'gpt-5.6 · ~/repo', '  ? for shortcuts'],
      [false, false, true]
    ]
  ])('does not mask %s', (_name, rowsBelow, rowsBelowWrapped) => {
    expect(
      hasTerminalComposerPlaceholder({
        rows: ['› Ask Codex to do anything'],
        typedRows: ['›'],
        promptGlyphBoldRows: [true],
        rowsBelow,
        typedRowsBelow: rowsBelow,
        rowsBelowWrapped,
        beforeCursor: '› ',
        afterCursor: '',
        rawAfterCursor: 'Ask Codex to do anything',
        cursorHidden: false,
        cursorViewportRow: 4
      })
    ).toBe(false)
  })
})
