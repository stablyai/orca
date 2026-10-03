import { describe, expect, it } from 'vitest'
import {
  haveSameDisabledTuiAgents,
  normalizeDisabledTuiAgents,
  normalizeTerminalIncognitoAgents,
  pickTuiAgent
} from './tui-agent-selection'

describe('pickTuiAgent', () => {
  it('uses an installed preferred agent', () => {
    expect(pickTuiAgent('codex', ['claude', 'codex'])).toBe('codex')
  })

  it('falls back in desktop catalog order when the preference is absent or stale', () => {
    expect(pickTuiAgent(null, ['cursor', 'codex'])).toBe('codex')
    expect(pickTuiAgent('gemini', ['cursor', 'codex'])).toBe('codex')
    expect(pickTuiAgent(null, ['continue', 'command-code'])).toBe('command-code')
  })

  it('respects the explicit blank terminal preference', () => {
    expect(pickTuiAgent('blank', ['cursor', 'claude'])).toBeNull()
  })

  it('ignores disabled preferred and fallback agents', () => {
    expect(pickTuiAgent('codex', ['claude', 'codex'], ['codex'])).toBe('claude')
    expect(pickTuiAgent(null, ['claude', 'codex'], ['claude', 'codex'])).toBeNull()
  })
})

describe('normalizeDisabledTuiAgents', () => {
  it('dedupes supported agent ids and drops unsupported values', () => {
    expect(normalizeDisabledTuiAgents(['codex', 'unknown', 'codex', null, 'claude'])).toEqual([
      'codex',
      'claude'
    ])
  })
})

describe('normalizeTerminalIncognitoAgents', () => {
  it('keeps only incognito-capable agents and drops the rest', () => {
    // 'claude'/'codex' cannot be made ephemeral, so they are dropped even though they are valid
    // agent ids; the live ['pi'] setting must survive.
    expect(
      normalizeTerminalIncognitoAgents(['pi', 'claude', 'omp', 'codex', 'pi', 'unknown'])
    ).toEqual(['pi', 'omp'])
    expect(normalizeTerminalIncognitoAgents(['pi'])).toEqual(['pi'])
    expect(normalizeTerminalIncognitoAgents(['claude'])).toEqual([])
  })
})

describe('haveSameDisabledTuiAgents', () => {
  it('compares the normalized disabled-agent sets', () => {
    expect(haveSameDisabledTuiAgents(['codex', 'claude'], ['claude', 'codex'])).toBe(true)
    expect(haveSameDisabledTuiAgents(['codex', 'unknown'], ['codex'])).toBe(true)
    expect(haveSameDisabledTuiAgents(['codex'], ['claude'])).toBe(false)
  })
})
