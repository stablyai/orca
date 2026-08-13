import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ChecksPanelBranchRow } from './checks-panel-branch-row'

describe('ChecksPanelBranchRow', () => {
  it('renders nothing when no branch is known', () => {
    expect(renderToStaticMarkup(<ChecksPanelBranchRow />)).toBe('')
  })

  it('shows the base branch alone when the head branch is unknown (e.g. GitLab)', () => {
    const html = renderToStaticMarkup(<ChecksPanelBranchRow baseRefName="main" />)
    expect(html).toContain('main')
    // Only the base pill renders, so there is no head pill to point an arrow at.
    expect(html).not.toContain('lucide-arrow-left')
  })

  it('shows base ← head with a direction arrow when both branches are known', () => {
    const html = renderToStaticMarkup(
      <ChecksPanelBranchRow baseRefName="main" headRefName="feature/x" />
    )
    expect(html).toContain('main')
    expect(html).toContain('feature/x')
    expect(html).toContain('lucide-arrow-left')
  })
})
