import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { AdvancedPane } from './AdvancedPane'
import { getAdvancedSearchEntry } from './advanced-search'

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: { settingsSearchQuery: string }) => unknown) =>
    selector({ settingsSearchQuery: '' })
}))

describe('AdvancedPane', () => {
  it('renders HTTP/1.1 compatibility as a neutral advanced setting', () => {
    const markup = renderToStaticMarkup(
      <AdvancedPane settings={getDefaultSettings('/tmp')} updateSettings={vi.fn()} />
    )

    expect(markup).toContain('Compatibility')
    expect(markup).toContain('HTTP/1.1 Compatibility')
    expect(markup).toContain('aria-checked="false"')
    expect(markup).toContain('Explain HTTP/1.1 compatibility')
    expect(getAdvancedSearchEntry().http1Compatibility.keywords).toContain('support')
    expect(getAdvancedSearchEntry().http1Compatibility.keywords).toContain('troubleshooting')
  })
})
