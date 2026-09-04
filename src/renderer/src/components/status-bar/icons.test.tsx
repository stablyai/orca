import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MiniMaxIcon, ZaiIcon } from './icons'

describe('MiniMaxIcon', () => {
  it('renders the official MiniMax mark as an image', () => {
    const markup = renderToStaticMarkup(<MiniMaxIcon size={14} />)
    expect(markup.startsWith('<img')).toBe(true)
    expect(markup).toContain('aria-hidden="true"')
    expect(markup).toContain('width="14"')
    expect(markup).toContain('height="14"')
  })

  it('honors a custom size prop', () => {
    const markup = renderToStaticMarkup(<MiniMaxIcon size={20} />)
    expect(markup).toContain('width="20"')
    expect(markup).toContain('height="20"')
  })

  it('does not render the legacy "M" placeholder text', () => {
    const markup = renderToStaticMarkup(<MiniMaxIcon size={14} />)
    expect(markup).not.toContain('>M<')
  })
})

describe('ZaiIcon', () => {
  it('renders a monochrome currentColor SVG Z glyph', () => {
    const markup = renderToStaticMarkup(<ZaiIcon size={13} />)
    expect(markup.startsWith('<svg')).toBe(true)
    expect(markup).toContain('fill="currentColor"')
    expect(markup).toContain('width="13"')
    expect(markup).toContain('height="13"')
    // A letter-Z silhouette: top bar, diagonal, bottom bar.
    expect(markup).toContain('d="M5 4h14v3l-9.5 10H19v3H5v-3l9.5-10H5V4z"')
  })

  it('honors a custom size prop', () => {
    const markup = renderToStaticMarkup(<ZaiIcon size={20} />)
    expect(markup).toContain('width="20"')
    expect(markup).toContain('height="20"')
  })
})
