import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { HostGlyph } from '@/components/host-picker/host-row-icon'

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
})
