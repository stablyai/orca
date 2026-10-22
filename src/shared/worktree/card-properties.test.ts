import { describe, expect, it } from 'vitest'
import {
  getWorktreeCardDetails,
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

  it('recognizes only exact defaulted Compact presets', () => {
    expect(isDefaultedCompactWorktreeCardProperties(['status'])).toBe(true)
    expect(isDefaultedCompactWorktreeCardProperties(['status', 'unread'])).toBe(true)
    expect(isDefaultedCompactWorktreeCardProperties(['status', 'automation'])).toBe(true)
    expect(isDefaultedCompactWorktreeCardProperties(['status', 'unread', 'automation'])).toBe(true)
    expect(isDefaultedCompactWorktreeCardProperties(['automation', 'status'])).toBe(false)
    expect(isDefaultedCompactWorktreeCardProperties(['status', 'automation', 'pr'])).toBe(false)
  })
})

describe('getWorktreeCardDetails', () => {
  it('shows each chosen property, and compact cards leave out the host and agent rows', () => {
    const chosen = ['pr', 'host', 'inline-agents'] as const
    expect(
      getWorktreeCardDetails(chosen, { compactWorktreeCards: false, newCardStyle: false })
    ).toMatchObject({
      compactCards: false,
      repoInTitle: false,
      metaRow: true,
      pr: true,
      host: true,
      inlineAgents: true,
      comment: false
    })
    expect(
      getWorktreeCardDetails(chosen, { compactWorktreeCards: true, newCardStyle: false })
    ).toMatchObject({
      compactCards: true,
      repoInTitle: true,
      metaRow: false,
      pr: true,
      host: false,
      inlineAgents: false
    })
  })

  it('lets the new card style override the Compact layout', () => {
    expect(
      getWorktreeCardDetails(['host', 'inline-agents'], {
        compactWorktreeCards: true,
        newCardStyle: true
      })
    ).toMatchObject({
      compactCards: false,
      // The new card style keeps a meta row but uses the title chip for the repo.
      repoInTitle: true,
      metaRow: true,
      host: true,
      inlineAgents: true
    })
  })
})
