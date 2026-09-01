import { describe, expect, it } from 'vitest'
import {
  haveSameDisabledTuiAgents,
  normalizeDisabledTuiAgents,
  pickTuiAgent,
  toLegacyAutoPreference
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

describe('toLegacyAutoPreference', () => {
  it('maps the migrated Auto spellings to the legacy Auto null', () => {
    expect(toLegacyAutoPreference('auto')).toBeNull()
    expect(toLegacyAutoPreference(undefined)).toBeNull()
  })

  it('passes concrete and blank preferences through unchanged', () => {
    expect(toLegacyAutoPreference('codex')).toBe('codex')
    expect(toLegacyAutoPreference('blank')).toBe('blank')
  })

  it('does not let a repaired/cleared null default fall back to Auto', () => {
    // Deleting the default with `clear`, or disabling a base that the default
    // derived from, stores null. Auto would launch whatever is installed.
    expect(toLegacyAutoPreference(null)).toBe('blank')
    expect(pickTuiAgent(toLegacyAutoPreference(null), ['claude', 'codex'])).toBeNull()
    // Auto still auto-picks.
    expect(pickTuiAgent(toLegacyAutoPreference('auto'), ['claude', 'codex'])).toBe('claude')
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

describe('haveSameDisabledTuiAgents', () => {
  it('compares the normalized disabled-agent sets', () => {
    expect(haveSameDisabledTuiAgents(['codex', 'claude'], ['claude', 'codex'])).toBe(true)
    expect(haveSameDisabledTuiAgents(['codex', 'unknown'], ['codex'])).toBe(true)
    expect(haveSameDisabledTuiAgents(['codex'], ['claude'])).toBe(false)
  })
})
