import { describe, expect, it } from 'vitest'
import { isMeaningfulOpenCodeTerminalTitle } from './opencode-terminal-title'

describe('OpenCode terminal titles', () => {
  it('recognizes native session titles', () => {
    expect(isMeaningfulOpenCodeTerminalTitle('OC | Native Stable Session')).toBe(true)
    expect(isMeaningfulOpenCodeTerminalTitle('  OC|Session  ')).toBe(true)
  })

  it('rejects generic or incomplete OpenCode titles', () => {
    expect(isMeaningfulOpenCodeTerminalTitle('OpenCode')).toBe(false)
    expect(isMeaningfulOpenCodeTerminalTitle('OpenCode ready')).toBe(false)
    expect(isMeaningfulOpenCodeTerminalTitle('OC |')).toBe(false)
    expect(isMeaningfulOpenCodeTerminalTitle(undefined)).toBe(false)
  })
})
