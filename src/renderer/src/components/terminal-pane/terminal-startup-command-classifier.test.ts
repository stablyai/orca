import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getTerminalStartupCommandToken,
  isCodexTerminalStartupCommand,
  TERMINAL_STARTUP_COMMAND_TOKEN_MAX_CHARS
} from './terminal-startup-command-classifier'

afterEach(() => {
  vi.restoreAllMocks()
})

function getRegexWhitespaceSplitCalls(split: ReturnType<typeof vi.spyOn>): unknown[][] {
  return split.mock.calls.filter(
    ([pattern]) => pattern instanceof RegExp && pattern.source === '\\s+'
  )
}

describe('terminal startup command classifier', () => {
  it('extracts the first startup command token without regex whitespace splitting', () => {
    const split = vi.spyOn(String.prototype, 'split')
    const command = [' ', String.fromCharCode(160), 'codex\t--ask'].join('')

    expect(getTerminalStartupCommandToken(command)).toBe('codex')
    expect(isCodexTerminalStartupCommand(command)).toBe(true)
    expect(getRegexWhitespaceSplitCalls(split)).toHaveLength(0)
  })

  it('recognizes quoted Windows Codex executables', () => {
    const command = '"C:\\Program Files\\Orca\\codex.cmd" --resume'

    expect(getTerminalStartupCommandToken(command)).toBe('C:\\Program Files\\Orca\\codex.cmd')
    expect(isCodexTerminalStartupCommand(command)).toBe(true)
  })

  it('recognizes POSIX Codex wrapper names', () => {
    expect(isCodexTerminalStartupCommand('/usr/local/bin/codex-agent --continue')).toBe(true)
    expect(isCodexTerminalStartupCommand('/usr/local/bin/not-codex --continue')).toBe(false)
  })

  it('bounds pathological single-token startup commands', () => {
    const split = vi.spyOn(String.prototype, 'split')
    const command = 'codex'.repeat(TERMINAL_STARTUP_COMMAND_TOKEN_MAX_CHARS)

    expect(getTerminalStartupCommandToken(command)).toHaveLength(
      TERMINAL_STARTUP_COMMAND_TOKEN_MAX_CHARS
    )
    expect(isCodexTerminalStartupCommand(command)).toBe(false)
    expect(getRegexWhitespaceSplitCalls(split)).toHaveLength(0)
  })
})
