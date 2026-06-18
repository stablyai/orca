import { describe, expect, it } from 'vitest'
import {
  createAutoSaveDelayDraftState,
  createHttpProxyBypassRulesDraftState,
  createHttpProxyUrlDraftState,
  getDesktopPlatformFromUserAgent,
  getGeneralPaneSearchEntries,
  getTabOrderControlSearchKeywords,
  setHttpProxyUrlDraftErrorState,
  shouldCommitOpenInApplicationsDraft,
  updateAutoSaveDelayDraftState,
  updateHttpProxyBypassRulesDraftState,
  updateHttpProxyUrlDraftState
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

describe('GeneralPane proxy drafts', () => {
  it('keeps a committed proxy URL draft tied to the current persisted source', () => {
    const current = createHttpProxyUrlDraftState(undefined)

    expect(updateHttpProxyUrlDraftState(current, undefined, 'http://proxy.test:8080')).toEqual({
      sourceValue: '',
      draft: 'http://proxy.test:8080',
      error: null
    })
  })

  it('reconciles stale proxy URL state and clears errors before applying a new draft', () => {
    const current = setHttpProxyUrlDraftErrorState(
      updateHttpProxyUrlDraftState(
        createHttpProxyUrlDraftState('http://old.test:8080'),
        'http://old.test:8080',
        'bad proxy'
      ),
      'http://old.test:8080',
      'Invalid proxy URL'
    )

    expect(
      updateHttpProxyUrlDraftState(current, 'http://new.test:8080', 'http://typed.test:8080')
    ).toEqual({
      sourceValue: 'http://new.test:8080',
      draft: 'http://typed.test:8080',
      error: null
    })
  })

  it('keeps committed proxy bypass rules tied to the current persisted source', () => {
    const current = createHttpProxyBypassRulesDraftState('localhost')

    expect(
      updateHttpProxyBypassRulesDraftState(current, 'localhost', 'localhost,127.0.0.1')
    ).toEqual({
      sourceValue: 'localhost',
      draft: 'localhost,127.0.0.1'
    })
  })

  it('reconciles stale proxy bypass rules before applying a new draft', () => {
    const current = updateHttpProxyBypassRulesDraftState(
      createHttpProxyBypassRulesDraftState('localhost'),
      'localhost',
      'localhost,127.0.0.1'
    )

    expect(updateHttpProxyBypassRulesDraftState(current, '*.internal', '*.corp')).toEqual({
      sourceValue: '*.internal',
      draft: '*.corp'
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
