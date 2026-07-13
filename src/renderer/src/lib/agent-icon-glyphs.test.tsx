// @vitest-environment happy-dom

// Agent logos fetched from Google's favicon service render a broken-image glyph
// when Google is unreachable (offline, firewall, blocked region, SSH host). These
// tests pin the onError fallback that swaps the broken image for a letter badge.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentFaviconIcon } from './agent-icon-glyphs'
import { AgentIcon } from './agent-catalog'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function failFavicon(): void {
  const img = container.querySelector('img')
  if (!img) {
    throw new Error('expected a favicon <img> before the error event')
  }
  act(() => {
    img.dispatchEvent(new Event('error'))
  })
}

describe('AgentFaviconIcon', () => {
  it('renders the favicon image at the requested size from the Google favicon service', () => {
    act(() => root.render(<AgentFaviconIcon domain="cursor.com" fallbackLetter="C" size={20} />))
    const img = container.querySelector('img')
    expect(img).not.toBeNull()
    // sz=64 keeps the favicon crisp when scaled down; size forwards to the box.
    expect(img?.getAttribute('src')).toBe('https://www.google.com/s2/favicons?domain=cursor.com&sz=64')
    expect(img?.getAttribute('width')).toBe('20')
    expect(img?.getAttribute('height')).toBe('20')
    expect(container.querySelector('svg')).toBeNull()
  })

  it('falls back to the letter badge when the favicon fails to load', () => {
    act(() => root.render(<AgentFaviconIcon domain="cursor.com" fallbackLetter="C" />))
    failFavicon()
    expect(container.querySelector('img')).toBeNull()
    const svg = container.querySelector('svg')
    expect(svg).not.toBeNull()
    expect(svg?.textContent).toBe('C')
  })

  it('evaluates each agent independently as the same slot switches domains', () => {
    // First agent fails -> its letter badge.
    act(() => root.render(<AgentFaviconIcon domain="cursor.com" fallbackLetter="C" />))
    failFavicon()
    expect(container.querySelector('img')).toBeNull()

    // Switching to a second agent retries the favicon, and that agent can fall
    // back on its own error rather than inheriting the first agent's failure.
    act(() => root.render(<AgentFaviconIcon domain="x.ai" fallbackLetter="G" />))
    expect(container.querySelector('img')?.getAttribute('src')).toContain('domain=x.ai')
    failFavicon()
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('svg')?.textContent).toBe('G')

    // Switching back retries the favicon instead of staying on the letter.
    act(() => root.render(<AgentFaviconIcon domain="cursor.com" fallbackLetter="C" />))
    expect(container.querySelector('img')?.getAttribute('src')).toContain('domain=cursor.com')
  })
})

describe('AgentIcon wiring for favicon-based agents', () => {
  it('renders a favicon-based agent and degrades to its initial on error', () => {
    act(() => root.render(<AgentIcon agent="grok" />))
    expect(container.querySelector('img')?.getAttribute('src')).toContain('domain=x.ai')
    failFavicon()
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('svg')?.textContent).toBe('G')
  })
})
