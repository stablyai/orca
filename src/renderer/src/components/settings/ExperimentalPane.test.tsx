import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { ExperimentalPane } from './ExperimentalPane'
import { EXPERIMENTAL_SEARCH_ENTRY } from './experimental-search'

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: { settingsSearchQuery: string }) => unknown) =>
    selector({ settingsSearchQuery: '' })
}))

describe('ExperimentalPane', () => {
  it('renders compact worktree cards as an off-by-default experimental switch', () => {
    const markup = renderToStaticMarkup(
      <ExperimentalPane settings={getDefaultSettings('/tmp')} updateSettings={vi.fn()} />
    )

    expect(markup).toContain('Compact worktree cards')
    expect(markup).toContain('aria-checked="false"')
    expect(markup).toContain('single title row')
    expect(markup).toContain('selected properties on a second row')
    expect(EXPERIMENTAL_SEARCH_ENTRY.compactWorktreeCards.keywords).toContain('metadata')
  })
})
