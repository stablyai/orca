import { describe, expect, it } from 'vitest'
import {
  getWorktreeCardModeProperties,
  getWorktreeCardModeUpdates,
  isDefaultedCompactWorktreeCardProperties,
  normalizeWorktreeCardProperties
} from './card-properties'

describe('worktree card properties', () => {
  it('normalizes fixed and legacy properties while preserving selected properties', () => {
    expect(normalizeWorktreeCardProperties(['ci', 'branch', 'pr', 'automation', 'unread'])).toEqual(
      ['status', 'unread', 'ci', 'branch', 'pr', 'automation']
    )
  })

  it('returns combined mode update payloads', () => {
    expect(getWorktreeCardModeUpdates('Compact')).toEqual({
      settings: { compactWorktreeCards: true },
      ui: {
        worktreeCardProperties: getWorktreeCardModeProperties('Compact'),
        _worktreeCardModeDefaulted: true
      }
    })
  })

  it('defines Compact as the quiet preset (status + gated context pressure)', () => {
    const props = getWorktreeCardModeProperties('Compact')

    // context-pressure is inert until experimentalContextPressure is enabled,
    // so the preset stays visually status-only by default.
    expect(props).toEqual(['status', 'context-pressure'])
    expect(props).not.toContain('inline-agents')
    expect(props).not.toContain('issue')
  })

  it('recognizes only exact defaulted Compact presets', () => {
    expect(isDefaultedCompactWorktreeCardProperties(['status'])).toBe(true)
    expect(isDefaultedCompactWorktreeCardProperties(['status', 'unread'])).toBe(true)
    expect(isDefaultedCompactWorktreeCardProperties(['status', 'automation'])).toBe(true)
    expect(isDefaultedCompactWorktreeCardProperties(['status', 'unread', 'automation'])).toBe(true)
    expect(isDefaultedCompactWorktreeCardProperties(['status', 'context-pressure'])).toBe(true)
    expect(isDefaultedCompactWorktreeCardProperties(['status', 'unread', 'context-pressure'])).toBe(
      true
    )
    expect(isDefaultedCompactWorktreeCardProperties(['automation', 'status'])).toBe(false)
    expect(isDefaultedCompactWorktreeCardProperties(['status', 'automation', 'pr'])).toBe(false)
  })
})
