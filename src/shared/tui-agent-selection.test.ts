import { describe, expect, it } from 'vitest'
import { pickTuiAgent } from './tui-agent-selection'

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
})
