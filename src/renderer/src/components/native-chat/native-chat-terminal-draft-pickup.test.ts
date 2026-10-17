import { readFileSync } from 'node:fs'
import { SerializeAddon } from '@xterm/addon-serialize'
import { Terminal } from '@xterm/headless'
import { describe, expect, it } from 'vitest'
import type { NativeChatLaunchDraft } from '@/lib/native-chat-launch-prompt'
import { readTerminalCursorLineContext } from '../../../../shared/terminal-cursor-line-context'
import {
  agentInputLineText,
  planNativeChatTerminalDraftPickup
} from './native-chat-terminal-draft-pickup'

const NOW = 5_000

function seed(overrides: Partial<NativeChatLaunchDraft> = {}): NativeChatLaunchDraft {
  return { tabId: 'tab-1', agent: 'claude', text: 'earlier text', createdAt: 1_000, ...overrides }
}

function plan(args: { current?: NativeChatLaunchDraft | null; terminalText?: string | null }) {
  return planNativeChatTerminalDraftPickup({
    tabId: 'tab-1',
    agent: 'claude',
    current: args.current ?? null,
    terminalText: args.terminalText ?? null,
    now: NOW
  })
}

describe('planNativeChatTerminalDraftPickup', () => {
  it('seeds text left on the input line', () => {
    expect(plan({ terminalText: 'fix the test' })).toEqual({
      kind: 'seed',
      draft: {
        tabId: 'tab-1',
        agent: 'claude',
        text: 'fix the test',
        createdAt: NOW,
        fromTerminal: true
      }
    })
  })

  it('replaces an adopted terminal seed whose text changed in the terminal', () => {
    expect(
      plan({
        current: seed({ fromTerminal: true, adopted: true }),
        terminalText: 'earlier text, edited'
      })
    ).toEqual({
      kind: 'seed',
      draft: {
        tabId: 'tab-1',
        agent: 'claude',
        text: 'earlier text, edited',
        createdAt: NOW,
        fromTerminal: true,
        replacesText: 'earlier text'
      }
    })
  })

  it('replaces an unadopted terminal seed without naming a composer copy', () => {
    expect(plan({ current: seed({ fromTerminal: true }), terminalText: 'newer text' })).toEqual({
      kind: 'seed',
      draft: {
        tabId: 'tab-1',
        agent: 'claude',
        text: 'newer text',
        createdAt: NOW,
        fromTerminal: true
      }
    })
  })

  it('keeps a seed that already holds the same text', () => {
    expect(
      plan({ current: seed({ fromTerminal: true, adopted: true }), terminalText: 'earlier text' })
    ).toEqual({ kind: 'none' })
  })

  it('leaves a draft Orca typed into the input line alone', () => {
    expect(plan({ current: seed(), terminalText: 'earlier text plus more' })).toEqual({
      kind: 'none'
    })
    expect(plan({ current: seed(), terminalText: '' })).toEqual({ kind: 'none' })
  })

  it('resolves a terminal seed once the input line is empty', () => {
    const current = seed({ fromTerminal: true, adopted: true })
    expect(plan({ current, terminalText: '' })).toEqual({ kind: 'resolve', draft: current })
  })

  it('does nothing when the input line cannot be read', () => {
    expect(plan({ current: seed({ fromTerminal: true }) })).toEqual({ kind: 'none' })
    expect(plan({})).toEqual({ kind: 'none' })
  })
})

/** Replays a captured Claude Code transcript, optionally only up to the frame drawn before `until`. */
async function replay(name: string, until?: string) {
  const fixture = (ext: string) =>
    readFileSync(
      new URL(`../../../../main/runtime/__fixtures__/${name}${ext}`, import.meta.url),
      'utf8'
    )
  const meta: { cols: number; rows: number } = JSON.parse(fixture('.meta.json'))
  let data = fixture('.txt')
  if (until) {
    // Cut where the cursor was last shown before `until` was drawn: a whole frame, as the user saw it.
    data = data.slice(0, data.lastIndexOf('\x1b[?25h', data.indexOf(until)) + '\x1b[?25h'.length)
  }
  const terminal = new Terminal({ cols: meta.cols, rows: meta.rows, allowProposedApi: true })
  const serializer = new SerializeAddon()
  terminal.loadAddon(serializer)
  await new Promise<void>((resolve) => terminal.write(data, resolve))
  return agentInputLineText(
    readTerminalCursorLineContext(terminal, terminal.rows),
    serializer.serialize({ scrollback: 0 })
  )
}

describe('agentInputLineText', () => {
  it('reads text left unsent, where Claude wraps a long line onto a new row', async () => {
    expect(await replay('claude-2-1-301-unsent-draft')).toBe(
      'please look at the flaky retry test in the settlement module and explain why it times out under\nload on CI runners'
    )
  })

  it("reads Claude's startup placeholder as an empty line", async () => {
    expect(await replay('claude-2-1-301-unsent-draft', 'please look')).toBe('')
  })

  it('reads the input line after a finished turn as empty', async () => {
    expect(await replay('claude-2-1-301-turn-ended')).toBe('')
  })

  it('reads a suggestion drawn dim right of the cursor as an empty line', () => {
    const context = {
      rows: ['────────', '❯ proceed with the release'],
      typedRows: ['────────', '❯'],
      promptGlyphBoldRows: [false, false],
      rowsBelow: [],
      typedRowsBelow: [],
      beforeCursor: '❯ ',
      afterCursor: '',
      rawAfterCursor: 'proceed with the release',
      cursorHidden: false,
      cursorViewportRow: 8
    }

    expect(agentInputLineText(context, null)).toBe('')
  })

  it('reads nothing while a dialog replaces the input line', async () => {
    expect(await replay('claude-dialog-trust-workspace')).toBeNull()
  })
})
