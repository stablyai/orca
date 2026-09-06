// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BrowserFavicon } from './browser-favicon'

let container: HTMLDivElement
let root: Root

function render(faviconUrl: string | null, loading = false): void {
  act(() =>
    root.render(<BrowserFavicon faviconUrl={faviconUrl} loading={loading} className="size-4" />)
  )
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('BrowserFavicon', () => {
  it('renders a normalized web favicon', () => {
    render('  https://example.com/favicon.ico  ')

    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      'https://example.com/favicon.ico'
    )
    expect(container.querySelector('img')?.className).toContain('size-4')
  })

  it('falls back for invalid and failed favicons', () => {
    render('javascript:alert(1)')
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('svg')).not.toBeNull()

    render('https://example.com/favicon.ico')
    act(() => container.querySelector('img')?.dispatchEvent(new Event('error')))
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('svg')).not.toBeNull()
  })

  it('retries a failed URL after its identity changes', () => {
    const faviconUrl = 'https://example.com/favicon.ico'
    render(faviconUrl)
    act(() => container.querySelector('img')?.dispatchEvent(new Event('error')))

    render('https://example.org/favicon.ico')
    render(faviconUrl)

    expect(container.querySelector('img')?.getAttribute('src')).toBe(faviconUrl)
  })

  it('retries a failed URL when a reload settles', () => {
    const faviconUrl = 'https://example.com/favicon.ico'
    render(faviconUrl)
    act(() => container.querySelector('img')?.dispatchEvent(new Event('error')))

    render(faviconUrl, true)
    expect(container.firstElementChild?.className).toContain('motion-safe:animate-spin')
    render(faviconUrl)

    expect(container.querySelector('img')?.getAttribute('src')).toBe(faviconUrl)
  })
})
