import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { HostGlyph } from '@/components/host-row-icon'
import { CLOUD_GLYPH_SHAPE } from './CloudStatusGlyph'

describe('cloud status glyph', () => {
  it('shows a cloud workspace state in the cloud itself, with no dot badge', () => {
    const html = renderToStaticMarkup(<HostGlyph kind="orca-cloud" state="sleeping" />)
    expect(html).toContain('data-cloud-glyph-state="sleeping"')
    expect(html).not.toContain('data-cloud-state=')
  })

  it('keeps the corner dot for a recipe VM', () => {
    const html = renderToStaticMarkup(<HostGlyph kind="recipe-vm" state="sleeping" />)
    expect(html).toContain('data-cloud-state="sleeping"')
    expect(html).not.toContain('data-cloud-glyph-state')
  })

  it('keeps one cloud shape for every state but Archived (dashed) and unknown (dotted edge)', () => {
    const groups = new Map<string, string[]>()
    for (const [state, shape] of Object.entries(CLOUD_GLYPH_SHAPE)) {
      const key = `${shape.fill}/${shape.outline}`
      groups.set(key, [...(groups.get(key) ?? []), state])
    }
    // Option A: colour carries state (and the row and accessible name say it); Archived is B's.
    expect(Object.fromEntries(groups)).toEqual({
      'full/solid': [
        'running',
        'waking',
        'starting',
        'restarting',
        'goingToSleep',
        'sleeping',
        'unresponsive',
        'failed',
        'wakeFailed'
      ],
      'none/dashed': ['archived'],
      'full/dotted': ['unknown']
    })
  })
})
