import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MiniMaxIcon } from './icons'

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
