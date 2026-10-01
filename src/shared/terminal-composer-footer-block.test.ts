import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Terminal } from '@xterm/headless'
import { describe, expect, it } from 'vitest'
import {
  detectTerminalComposerDraft,
  hasTerminalComposerPlaceholder
} from './terminal-composer-draft'
import { readTerminalCursorLineContext } from './terminal-cursor-line-context'

describe('Codex composer with a bottom status block', () => {
  it.each([
    ['captured help', ''],
    ['localized help', '\x1b7\x1b[40;1H\x1b[2K  按键帮助：选择候选词\x1b8'],
    ['changed bindings', '\x1b7\x1b[40;1H\x1b[2K  F1 Help | F2 Commands\x1b8'],
    ['multiple help rows', '\x1b7\x1b[40;1H\x1b[2K  Commands\r\n  Navigation\r\n  Input\x1b8'],
    ['wrapped help', `\x1b7\x1b[40;1H\x1b[2K  ${'Help '.repeat(30)}\x1b8`],
    ['custom status text', '\x1b7\x1b[39;1H\x1b[2K\x1b[32m  自定义状态\x1b[0m\x1b8']
  ])('recognizes the recorded screen with %s', async (_name, repaint) => {
    const terminal = new Terminal({ cols: 120, rows: 44, allowProposedApi: true })
    try {
      const transcript = readFileSync(
        join(__dirname, '../main/runtime/__fixtures__/codex-0157-plain-ready.txt'),
        'utf8'
      )
      await new Promise<void>((resolve) => terminal.write(transcript, resolve))
      const context = readTerminalCursorLineContext(terminal, terminal.rows)
      expect(context?.rowsBelow.slice(0, 3)).toEqual([
        '',
        expect.stringContaining('GPT-6-Sol medium'),
        '  ← for agents · ? for shortcuts'
      ])
      if (repaint) {
        await new Promise<void>((resolve) => terminal.write(repaint, resolve))
      }
      const repainted = readTerminalCursorLineContext(terminal, terminal.rows)
      expect(hasTerminalComposerPlaceholder(repainted)).toBe(true)
      expect(detectTerminalComposerDraft(repainted)).toBeNull()

      await new Promise<void>((resolve) => terminal.write('\x1b[Kreview this', resolve))
      const draft = readTerminalCursorLineContext(terminal, terminal.rows)
      expect(hasTerminalComposerPlaceholder(draft)).toBe(false)
      expect(detectTerminalComposerDraft(draft)?.text).toBe('review this')
    } finally {
      terminal.dispose()
    }
  })

  it.each([
    ['colored output without a separating gap', ['status', 'help'], [false, false]],
    ['wrapped status row', ['', 'status', 'help'], [false, true, false]],
    [
      'unrelated output after a separated status block',
      ['', 'status', '', 'output'],
      [false, false, false, false]
    ],
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
        rowsBelowCustomForeground: rowsBelow.map((row) => row === 'status'),
        beforeCursor: '› ',
        afterCursor: '',
        rawAfterCursor: 'Ask Codex to do anything',
        cursorHidden: false,
        cursorViewportRow: 4
      })
    ).toBe(false)
  })
})
