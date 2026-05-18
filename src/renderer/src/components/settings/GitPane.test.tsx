import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { useAppStore } from '../../store'
import { GitPane, GIT_PANE_SEARCH_ENTRIES } from './GitPane'
import { matchesSettingsSearch } from './settings-search'

describe('GitPane', () => {
  beforeEach(() => {
    useAppStore.setState({ settingsSearchQuery: '' })
  })

  it('renders Source Control group order in Git settings', () => {
    const markup = renderToStaticMarkup(
      <GitPane
        settings={getDefaultSettings('/tmp')}
        updateSettings={vi.fn()}
        displayedGitUsername=""
      />
    )

    expect(markup).toContain('Source Control Group Order')
    expect(markup).toContain('Changes First')
    expect(markup).toContain('Staged First')
    expect(markup).toContain('Untracked First')
  })

  it('includes Source Control group order search metadata', () => {
    expect(matchesSettingsSearch('staged', GIT_PANE_SEARCH_ENTRIES)).toBe(true)
    expect(matchesSettingsSearch('group order', GIT_PANE_SEARCH_ENTRIES)).toBe(true)
  })
})
