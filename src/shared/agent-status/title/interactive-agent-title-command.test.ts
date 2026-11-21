/** STA-14925: only a title that reads as the TUI itself may hold tui-idle for that TUI's composer. */

import { describe, expect, it } from 'vitest'
import { titleCommandLaunchesInteractiveTui } from './interactive-agent-title-command'

describe('titleCommandLaunchesInteractiveTui', () => {
  it.each([
    'claude',
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
    'claude | less',
    'claude > v.txt',
    'claude < prompt.txt',
    'claude; echo done',
    'claude &'
  ])('rejects the pipeline or redirect %j', (title) => {
    expect(titleCommandLaunchesInteractiveTui(title, 'claude')).toBe(false)
  })

  it('rejects an informational launch', () => {
    expect(titleCommandLaunchesInteractiveTui('claude --help', 'claude')).toBe(false)
  })

  it.each(['claude --bogus-flag', 'FOO=1 claude', 'node /opt/claude/cli.js'])(
    'rejects %j: an argv it cannot read with confidence is not a known session',
    (title) => {
      expect(titleCommandLaunchesInteractiveTui(title, 'claude')).toBe(false)
    }
  )

  it('rejects the running agent status title as a launch command', () => {
    expect(titleCommandLaunchesInteractiveTui('✳ Claude Code', 'claude')).toBe(false)
  })

  it('rejects a command that launches a different agent than the title policy named', () => {
    expect(titleCommandLaunchesInteractiveTui('codex', 'claude')).toBe(false)
  })
})
