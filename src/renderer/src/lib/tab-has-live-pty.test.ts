import { describe, expect, it } from 'vitest'
import { tabHasLivePty } from './tab-has-live-pty'

describe('tabHasLivePty', () => {
  it('returns false for an empty map', () => {
    expect(tabHasLivePty({}, 'tab-1')).toBe(false)
  })

  it('returns false for a missing tab id', () => {
    expect(tabHasLivePty({ 'other-tab': ['pty-1'] }, 'tab-1')).toBe(false)
  })

  it('returns false for a tab whose live-pty array is empty (sleep / pre-spawn)', () => {
    // Why: sleep clears ptyIdsByTabId[tab.id] to [] while keeping tab.ptyId as
    // a wake-hint sessionId — that shape is the central regression this helper
    // exists to catch.
    expect(tabHasLivePty({ 'tab-1': [] }, 'tab-1')).toBe(false)
  })

  it('returns true for a tab with at least one live pty id', () => {
    expect(tabHasLivePty({ 'tab-1': ['pty-1'] }, 'tab-1')).toBe(true)
  })

  it('returns true for a tab with multiple live pty ids (split panes)', () => {
    expect(tabHasLivePty({ 'tab-1': ['pty-1', 'pty-2'] }, 'tab-1')).toBe(true)
  })
})
