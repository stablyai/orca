import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  COMMAND_TOKEN_SCAN_MAX_CHARS,
  commandContainsToken,
  getCommandTokenPathBasename,
  getFirstCommandToken
} from './command-token-scanner'

afterEach(() => {
  vi.restoreAllMocks()
})

function getRegexWhitespaceSplitCalls(split: ReturnType<typeof vi.spyOn>): unknown[][] {
  return split.mock.calls.filter(
    ([pattern]) => pattern instanceof RegExp && pattern.source === '\\s+'
  )
}

describe('command token scanner', () => {
  it('extracts a first command token across pasted whitespace without regex splitting', () => {
    const split = vi.spyOn(String.prototype, 'split')
    const command = [' ', String.fromCharCode(160), 'codex\t--resume'].join('')

    expect(getFirstCommandToken(command)).toBe('codex')
    expect(getRegexWhitespaceSplitCalls(split)).toHaveLength(0)
  })

  it('preserves quoted command paths with spaces', () => {
    expect(getFirstCommandToken('"C:\\Program Files\\Orca\\codex.cmd" --resume')).toBe(
      'C:\\Program Files\\Orca\\codex.cmd'
    )
  })

  it('extracts path basenames without allocating path segment arrays', () => {
    expect(getCommandTokenPathBasename('C:\\Program Files\\Orca\\codex.cmd')).toBe('codex.cmd')
    expect(getCommandTokenPathBasename('/usr/local/bin/omp')).toBe('omp')
  })

  it('bounds pathological single-token commands', () => {
    const split = vi.spyOn(String.prototype, 'split')
    const command = 'a'.repeat(COMMAND_TOKEN_SCAN_MAX_CHARS + 100)

    expect(getFirstCommandToken(command)).toHaveLength(COMMAND_TOKEN_SCAN_MAX_CHARS)
    expect(getRegexWhitespaceSplitCalls(split)).toHaveLength(0)
  })

  it('finds exact command tokens without regex splitting', () => {
    const split = vi.spyOn(String.prototype, 'split')
    const command = '/Applications/serve-sim/bin/serve-sim-bin\tUDID-1 --port 3100'

    expect(commandContainsToken(command, 'UDID-1')).toBe(true)
    expect(commandContainsToken(command, 'UDID')).toBe(false)
    expect(getRegexWhitespaceSplitCalls(split)).toHaveLength(0)
  })
})
