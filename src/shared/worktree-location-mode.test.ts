import { describe, expect, it } from 'vitest'
import { resolveWorktreeLocationMode } from './worktree-location-mode'

describe('resolveWorktreeLocationMode', () => {
  it('uses sibling as the default when neither repo nor settings choose a mode', () => {
    expect(resolveWorktreeLocationMode({}, {})).toBe('sibling')
  })

  it('follows the global default for repos without an explicit mode', () => {
    expect(resolveWorktreeLocationMode({}, { defaultWorktreeLocationMode: 'nested' })).toBe(
      'nested'
    )
    expect(resolveWorktreeLocationMode({}, { defaultWorktreeLocationMode: 'sibling' })).toBe(
      'sibling'
    )
  })

  it('lets explicit repo modes override the global default', () => {
    expect(
      resolveWorktreeLocationMode(
        { worktreeLocationMode: 'sibling' },
        { defaultWorktreeLocationMode: 'nested' }
      )
    ).toBe('sibling')
    expect(
      resolveWorktreeLocationMode(
        { worktreeLocationMode: 'nested' },
        { defaultWorktreeLocationMode: 'sibling' }
      )
    ).toBe('nested')
  })
})
