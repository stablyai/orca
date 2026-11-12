/** STA-14925: only a title that reads as the TUI itself may hold tui-idle for that TUI's composer. */

import { describe, expect, it } from 'vitest'
import { titleCommandLaunchesInteractiveTui } from './interactive-agent-title-command'

describe('titleCommandLaunchesInteractiveTui', () => {
  it.each([
    'claude',
    'claude --resume',
    'claude --model opus',
    'claude "summarize a | b"',
    "claude 'why --help?'",
    'claude -- --help',
    '/usr/local/bin/claude --continue',
    // Claude names itself this way in its own titles; the token is the program, not a pipeline.
    'Claude Code'
  ])('accepts the interactive launch %j', (title) => {
    expect(titleCommandLaunchesInteractiveTui(title, 'claude')).toBe(true)
  })

  it.each([
    'claude --help | less',
    'claude --help |less',
    'claude 2>&1 | tee out.log',
    'claude --version > v.txt',
    'claude < prompt.txt',
    'claude; echo done',
    'claude && echo done',
    'claude &'
  ])('rejects the pipeline or redirect %j', (title) => {
    expect(titleCommandLaunchesInteractiveTui(title, 'claude')).toBe(false)
  })

  it.each([
    'claude -p "summarize the diff"',
    'claude --print',
    'claude --output-format json',
    'claude --help',
    'claude -h',
    'claude --version',
    'claude -v'
  ])('rejects the one-shot %j', (title) => {
    expect(titleCommandLaunchesInteractiveTui(title, 'claude')).toBe(false)
  })

  it.each(['✳ Claude Code', '~/repo', 'zsh', 'less'])(
    'rejects a title that is not a command line launching the agent: %j',
    (title) => {
      expect(titleCommandLaunchesInteractiveTui(title, 'claude')).toBe(false)
    }
  )

  it('rejects a command that launches a different agent than the title policy named', () => {
    expect(titleCommandLaunchesInteractiveTui('codex', 'claude')).toBe(false)
  })
})
