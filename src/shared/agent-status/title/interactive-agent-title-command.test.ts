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
    // The command position is found past option values and past `--` (F41366-C3-1).
    'claude --model opus mcp serve',
    'claude --model=opus mcp serve',
    'claude --debug=x mcp serve',
    'claude -- mcp list',
    'claude -- mcp',
    '/usr/local/bin/claude mcp serve'
  ])('rejects the non-session subcommand %j', (title) => {
    expect(titleCommandLaunchesInteractiveTui(title, 'claude')).toBe(false)
  })

  it.each([
    // A prompt word, a quoted prompt, an option value, and the subcommands that open a session.
    'claude fix the mcp server',
    'claude "mcp serve"',
    'claude -- fix mcp',
    // `doctor` names the session; `mcp` is the optional debug filter and `serve` the prompt (F41366-C3-1).
    'claude --name doctor',
    'claude -n doctor',
    'claude --debug mcp serve',
    'claude attach 1a2b',
    'claude agents',
    'claude import codex'
  ])('accepts the session launch %j whose words only resemble a subcommand', (title) => {
    expect(titleCommandLaunchesInteractiveTui(title, 'claude')).toBe(true)
  })

  it.each(['claude --bg', 'claude --background', 'claude --background "fix the build"'])(
    'rejects the background launch %j, which prints an id and returns (F41366-C3-2)',
    (title) => {
      expect(titleCommandLaunchesInteractiveTui(title, 'claude')).toBe(false)
    }
  )

  it.each([
    'claude --bogus-flag',
    'claude -x',
    'claude --verbose=1',
    'claude --name',
    'FOO=1 claude',
    'node /opt/claude/cli.js'
  ])('rejects %j: an argv it cannot read with confidence is not a known session', (title) => {
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
