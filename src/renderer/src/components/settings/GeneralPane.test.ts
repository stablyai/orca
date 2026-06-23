import { describe, expect, it } from 'vitest'
import {
  createAutoSaveDelayDraftState,
  getDesktopPlatformFromUserAgent,
  getGeneralPaneSearchEntries,
  getTabOrderControlSearchKeywords,
  shouldCommitOpenInApplicationsDraft,
  shouldShowProjectRuntimeSection,
  updateAutoSaveDelayDraftState
} from './GeneralPane'
import { matchesSettingsSearch } from './settings-search'

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

describe('GeneralPane open-in application drafts', () => {
  it('does not commit rows until both label and command are present', () => {
    expect(
      shouldCommitOpenInApplicationsDraft([{ id: 'draft', label: 'Cursor', command: '' }])
    ).toBe(false)
    expect(
      shouldCommitOpenInApplicationsDraft([{ id: 'draft', label: '', command: 'cursor' }])
    ).toBe(false)
    expect(
      shouldCommitOpenInApplicationsDraft([{ id: 'draft', label: '   ', command: 'cursor' }])
    ).toBe(false)
    expect(
      shouldCommitOpenInApplicationsDraft([{ id: 'draft', label: 'Cursor', command: '   ' }])
    ).toBe(false)
  })

  it('allows commit when every draft row has a label and command', () => {
    expect(shouldCommitOpenInApplicationsDraft([])).toBe(true)
    expect(
      shouldCommitOpenInApplicationsDraft([{ id: 'cursor', label: 'Cursor', command: 'cursor' }])
    ).toBe(true)
    expect(
      shouldCommitOpenInApplicationsDraft([
        { id: 'cursor', label: 'Cursor', command: 'cursor' },
        { id: 'zed', label: 'Zed', command: 'zed' }
      ])
    ).toBe(true)
  })
})

describe('GeneralPane desktop platform detection', () => {
  it('keeps Windows available for Windows-only CLI settings', () => {
    expect(
      getDesktopPlatformFromUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      )
    ).toBe('win32')
    expect(getDesktopPlatformFromUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe(
      'darwin'
    )
    expect(getDesktopPlatformFromUserAgent('Mozilla/5.0 (X11; Linux x86_64)')).toBe('other')
  })
})

describe('GeneralPane navigation search keywords', () => {
  it('keeps pinned-tab keywords out of the Tab Order control', () => {
    const keywords = getTabOrderControlSearchKeywords()

    expect(keywords).toContain('Tab Order')
    expect(keywords).toContain('recent')
    expect(keywords).not.toContain('pinned')
    expect(keywords).not.toContain('confirm')
    expect(keywords).not.toContain('close')
  })
})

describe('GeneralPane search entries', () => {
  it('includes the default project runtime setting', () => {
    const entries = getGeneralPaneSearchEntries()

    expect(matchesSettingsSearch('default project runtime', entries)).toBe(true)
    expect(matchesSettingsSearch('windows host', entries)).toBe(true)
    expect(matchesSettingsSearch('wsl', entries)).toBe(true)
  })

  it('omits the default project runtime setting when Windows runtimes are unsupported', () => {
    const entries = getGeneralPaneSearchEntries({ includeProjectRuntime: false })

    expect(matchesSettingsSearch('default project runtime', entries)).toBe(false)
    expect(matchesSettingsSearch('windows host', entries)).toBe(false)
    expect(matchesSettingsSearch('wsl', entries)).toBe(false)
  })
})

describe('GeneralPane project runtime section visibility', () => {
  const entries = getGeneralPaneSearchEntries()

  it('hides the section on non-Windows hosts even with an empty search query', () => {
    // Regression: matchesSettingsSearch returns true for an empty query, so the
    // platform gate is what keeps the orphaned header off macOS/Linux.
    expect(shouldShowProjectRuntimeSection(false, '', [])).toBe(false)
    expect(shouldShowProjectRuntimeSection(undefined, '', [])).toBe(false)
  })

  it('shows the section on Windows-capable hosts when entries match', () => {
    expect(shouldShowProjectRuntimeSection(true, '', entries)).toBe(true)
    expect(shouldShowProjectRuntimeSection(true, 'wsl', entries)).toBe(true)
  })

  it('hides the section when a search query excludes the runtime entries', () => {
    expect(shouldShowProjectRuntimeSection(true, 'zzz-no-match', entries)).toBe(false)
  })
})
