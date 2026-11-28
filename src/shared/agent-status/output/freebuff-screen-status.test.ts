import { describe, expect, it } from 'vitest'
import { readFreebuffScreenStatus } from './freebuff-screen-status'

const FOOTER =
  ' DeepSeek V4.1 Flash Fast • high · /tmp/repo · /model to change · Chat: Fix session status'

const screen = (statusLines: readonly string[], above: readonly string[] = []): string[] => [
  ...above,
  ...statusLines,
  '╭──────────────────────────────────────────────────────────────╮',
  '│  Enter a coding task or / for commands                       │',
  '╰──────────────────────────────────────────────────────────────╯',
  FOOTER
]

describe('readFreebuffScreenStatus', () => {
  it.each(['260.6K (25%)', '4:59 left · 13.3K (1%)'])(
    'reports done for an idle bar labelled %s',
    (label) => {
      const lines = [
        ' ⎘ • 13m 52s • △▽',
        ` ${label.padEnd(60)}✕ End session`,
        ' ╭──────────────────────────────────────────────────────────────╮',
        ' │  Enter a coding task or / for commands                       │',
        ' ╰──────────────────────────────────────────────────────────────╯',
        FOOTER
      ]

      expect(readFreebuffScreenStatus(lines, true)).toEqual({ state: 'done' })
    }
  )

  it('reports done when the bar wraps and a blank row separates it from the composer', () => {
    const lines = [
      ' 233.5K (22%)                                      ⏱ 6m 17s',
      '                                                       X End session',
      '',
      '╭──────────────────────────────────────────────────────────────╮',
      '│  Enter a coding task or / for commands                       │',
      '╰──────────────────────────────────────────────────────────────╯',
      FOOTER
    ]

    expect(readFreebuffScreenStatus(lines, true)).toEqual({ state: 'done' })
  })

  it('reports done when the readout and the End session control are split across rows', () => {
    const lines = screen([
      ' 260.6K (25%)',
      '                                                       X End session'
    ])

    expect(readFreebuffScreenStatus(lines, true)).toEqual({ state: 'done' })
  })

  it('reports working while the agent is running', () => {
    const lines = screen([' working...                                              5m 47s  ■ Esc'])

    expect(readFreebuffScreenStatus(lines, true)).toEqual({ state: 'working' })
  })

  it('does not read a mid-turn readout as done', () => {
    // A notice replaces the streaming label while the readout sits above it, so
    // the readout alone must never settle the turn.
    const lines = screen([' Copied to clipboard', ' 260.6K (25%)'])

    expect(readFreebuffScreenStatus(lines, true)).toBeNull()
  })

  it('does not read assistant text above a transient notice as the bar', () => {
    const lines = screen([' to stop early, click ✕ End session', ' Copied to clipboard'])

    expect(readFreebuffScreenStatus(lines, true)).toBeNull()
  })

  it('keeps working when assistant output above it mentions End session', () => {
    const lines = screen([
      ' the output ends with ✕ End session and 13m 52s of elapsed time',
      ' working...                                              5m 47s  ■ Esc'
    ])

    expect(readFreebuffScreenStatus(lines, true)).toEqual({ state: 'working' })
  })

  it('ignores assistant output that starts with a working label above an idle bar', () => {
    const lines = screen([
      ' working... completed all tasks and closed the tab',
      ' 260.6K (25%)                                                ✕ End session'
    ])

    expect(readFreebuffScreenStatus(lines, true)).toEqual({ state: 'done' })
  })

  it('reports a session boundary before the first message', () => {
    const lines = screen(['', ''], [' Your first message starts the session.'])

    expect(readFreebuffScreenStatus(lines, true)).toEqual({
      state: 'done',
      sessionBoundary: true
    })
  })
})
