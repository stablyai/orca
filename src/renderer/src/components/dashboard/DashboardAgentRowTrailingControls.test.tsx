import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { DashboardAgentRowTrailingControls } from './DashboardAgentRowTrailingControls'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

describe('DashboardAgentRowTrailingControls', () => {
  it('renders an optional fork session action', () => {
    const markup = renderToStaticMarkup(
      <DashboardAgentRowTrailingControls
        paneKey="tab-1:leaf-1"
        relativeTimestamp="2m ago"
        expanded={false}
        hideExpand
        onDismiss={vi.fn()}
        onToggleExpanded={vi.fn()}
        onForkSession={vi.fn()}
      />
    )

    expect(markup).toContain('aria-label="Fork agent session"')
    expect(markup).toContain('title="Fork agent session"')
  })

  it('omits the fork action when no handler is provided', () => {
    const markup = renderToStaticMarkup(
      <DashboardAgentRowTrailingControls
        paneKey="tab-1:leaf-1"
        relativeTimestamp="2m ago"
        expanded={false}
        hideExpand
        onDismiss={vi.fn()}
        onToggleExpanded={vi.fn()}
      />
    )

    expect(markup).not.toContain('Fork agent session')
  })
})
