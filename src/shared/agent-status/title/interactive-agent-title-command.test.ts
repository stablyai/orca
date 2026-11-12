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

  it.each([
    'claude mcp serve',
    'claude mcp list',
    'claude doctor',
    'claude update',
    'claude install stable',
    'claude setup-token',
    'claude plugin install foo',
    'claude --debug mcp serve',
    '/usr/local/bin/claude mcp serve'
  ])('rejects the non-session subcommand %j', (title) => {
    expect(titleCommandLaunchesInteractiveTui(title, 'claude')).toBe(false)
  })

  it.each([
    // A prompt word, a quoted prompt, a prompt after `--`, and the subcommands that open a session.
    'claude fix the mcp server',
    'claude "mcp serve"',
    'claude -- mcp',
    'claude attach 1a2b',
    'claude agents',
    'claude import codex'
  ])('accepts the session launch %j whose words only resemble a subcommand', (title) => {
    expect(titleCommandLaunchesInteractiveTui(title, 'claude')).toBe(true)
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
