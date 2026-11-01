import { describe, expect, it, vi } from 'vitest'
import {
  createAutoSaveDelayDraftState,
  getAutoHideSingleTabStripSearchKeywords,
  shouldShowProjectRuntimeSection,
  updateAutoSaveDelayDraftState
} from './GeneralPane'

vi.mock('@/store', () => ({
  useAppStore: () => {
    throw new Error('Pure settings helpers must not access the app store')
  }
}))

vi.mock('@/components/terminal-pane/TerminalPane', () => ({
  default: () => {
    throw new Error('This suite must not render a terminal pane')
  }
}))

describe('GeneralPane auto-save delay drafts', () => {
  it('keeps a committed draft tied to the current persisted source while settings save is pending', () => {
    const current = createAutoSaveDelayDraftState(1000)

    expect(updateAutoSaveDelayDraftState(current, 1000, '1500')).toEqual({
      sourceDelayMs: 1000,
      draft: '1500'
    })
  })

  it('reconciles stale draft state before applying a new draft value', () => {
    const stale = updateAutoSaveDelayDraftState(createAutoSaveDelayDraftState(1000), 1000, '1500')

    expect(updateAutoSaveDelayDraftState(stale, 1250, '1750')).toEqual({
      sourceDelayMs: 1250,
      draft: '1750'
    })
  })
})

describe('GeneralPane navigation search keywords', () => {
  it('binds the auto-hide row to its own catalog entry, not a neighbour', () => {
    // A rebase that inserted a sibling setting above this one silently rebound the row to the
    // neighbour's keywords, so the row filtered itself out of a query that matched the section.
    const keywords = getAutoHideSingleTabStripSearchKeywords()

    expect(keywords).toContain('single')
    expect(keywords).toContain('strip')
    expect(keywords).toContain('auto hide')
    expect(keywords).not.toContain('running')
    expect(keywords).not.toContain('OMP')
  })
})

describe('GeneralPane project runtime section visibility', () => {
  it('hides the section on non-Windows hosts even with an empty search query', () => {
    // Empty searches match empty entries; the platform gate must suppress orphaned non-Windows headers.
    expect(shouldShowProjectRuntimeSection(false, '', [])).toBe(false)
    expect(shouldShowProjectRuntimeSection(undefined, '', [])).toBe(false)
  })
})
