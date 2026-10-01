import { describe, expect, it } from 'vitest'
import { tokenizeCommandLine } from './agent-command-line-entrypoint'
import { isOpenCodeRunCommand } from './opencode-headless-command'

const matches = (commandLine: string): boolean =>
  isOpenCodeRunCommand(tokenizeCommandLine(commandLine))

describe('isOpenCodeRunCommand', () => {
  it('matches the run subcommand, after global options too', () => {
    expect(matches('opencode run fix the bug')).toBe(true)
    expect(matches('/opt/homebrew/bin/opencode2 run --model x/y hi')).toBe(true)
    expect(matches('opencode --print-logs run hi')).toBe(true)
    expect(matches('opencode --log-level DEBUG run hi')).toBe(true)
    expect(matches('opencode --log-level=DEBUG run hi')).toBe(true)
  })

  it('does not match the TUI or any other subcommand', () => {
    expect(matches('opencode')).toBe(false)
    expect(matches('opencode .')).toBe(false)
    expect(matches('opencode2 --standalone')).toBe(false)
    expect(matches('opencode serve --port 4096')).toBe(false)
    expect(matches('opencode attach http://127.0.0.1:4096')).toBe(false)
    expect(matches('opencode mini')).toBe(false)
    expect(matches('opencode --log-level run')).toBe(false)
  })
})
