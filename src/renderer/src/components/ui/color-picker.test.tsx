import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ColorPicker } from './color-picker'

describe('ColorPicker', () => {
  it('renders a normalized custom color trigger', () => {
    const html = renderToStaticMarkup(
      <ColorPicker value="#ABCDEF" onChange={vi.fn()} label="Custom repo color" />
    )

    expect(html).toContain('aria-label="Custom repo color"')
    expect(html).toContain('#abcdef')
  })
})
