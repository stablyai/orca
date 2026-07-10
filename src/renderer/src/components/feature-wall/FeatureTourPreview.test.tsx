import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { FEATURE_TOUR_PREVIEW_COPY, FeatureTourPreview } from './FeatureTourPreview'

describe('FeatureTourPreview first-run copy', () => {
  it('teaches that workspaces keep terminal and agent activity together', () => {
    const workspaceFrame = FEATURE_TOUR_PREVIEW_COPY.find((frame) => frame.id === 1)

    expect(workspaceFrame?.caption).toContain('terminal')
    expect(workspaceFrame?.caption).toContain('agent activity')
  })

  it('teaches that opening a workspace returns to its terminal', () => {
    const terminalFrame = FEATURE_TOUR_PREVIEW_COPY.find((frame) => frame.id === 4)

    expect(terminalFrame?.caption).toContain('Open any workspace')
    expect(terminalFrame?.caption).toContain('return to its terminal')
  })

  it('renders the cycling captions into the first-run preview', () => {
    const html = renderToStaticMarkup(<FeatureTourPreview />)

    expect(html).toContain(
      'Each workspace keeps its branch, terminal, and agent activity together.'
    )
    expect(html).toContain('Open any workspace to return to its terminal')
  })
})
