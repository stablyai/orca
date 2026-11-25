import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WORKTREE_CARD_PROPERTIES,
  getWorktreeCardModeProperties,
  getWorktreeCardModeUpdates,
  normalizeWorktreeCardProperties
} from './card-properties'

// Switching layouts keeps a hand-picked property set; presets still follow the mode.
describe('getWorktreeCardModeUpdates', () => {
  const custom = normalizeWorktreeCardProperties(['status', 'branch', 'jira-issue'])

  it('round-trips a custom list through Compact and back', () => {
    const toCompact = getWorktreeCardModeUpdates('Compact', custom)
    expect(toCompact.ui.worktreeCardProperties).toEqual(custom)
    const back = getWorktreeCardModeUpdates('Default', toCompact.ui.worktreeCardProperties)
    expect(back.ui.worktreeCardProperties).toEqual(custom)
    expect(back.ui._worktreeCardModeDefaulted).toBe(false)
    expect(toCompact.settings.compactWorktreeCards).toBe(true)
    expect(back.settings.compactWorktreeCards).toBe(false)
  })

  it('applies the mode preset when the list is the other mode’s preset', () => {
    const toCompact = getWorktreeCardModeUpdates('Compact', [...DEFAULT_WORKTREE_CARD_PROPERTIES])
    expect(toCompact.ui.worktreeCardProperties).toEqual(getWorktreeCardModeProperties('Compact'))
    expect(toCompact.ui._worktreeCardModeDefaulted).toBe(true)
    const back = getWorktreeCardModeUpdates('Default', toCompact.ui.worktreeCardProperties)
    expect(back.ui.worktreeCardProperties).toEqual(getWorktreeCardModeProperties('Default'))
    expect(back.ui._worktreeCardModeDefaulted).toBe(true)
  })
})
