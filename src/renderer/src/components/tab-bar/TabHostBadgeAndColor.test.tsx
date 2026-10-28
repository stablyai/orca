/**
 * @vitest-environment happy-dom
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { TabHostBadgeAndColor } from './TabHostBadgeAndColor'

let root: Root | null = null
let host: HTMLDivElement | null = null

function render(props: Parameters<typeof TabHostBadgeAndColor>[0]): HTMLDivElement {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root?.render(<TabHostBadgeAndColor {...props} />))
  return host
}

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
})

describe('TabHostBadgeAndColor', () => {
  it('renders the badge before the swatch as siblings of the parent', () => {
    const container = render({ hostBadge: 'builder', color: '#ff0000', hidden: false })
    const [badge, swatch] = Array.from(container.children)
    expect(badge?.textContent).toBe('builder')
    expect(badge?.getAttribute('title')).toBe('builder')
    if (!(swatch instanceof HTMLElement)) {
      throw new Error('expected the colour swatch element')
    }
    expect(swatch.style.backgroundColor).not.toBe('')
    expect(container.children).toHaveLength(2)
  })

  it('renders nothing for null badge and null colour', () => {
    expect(render({ hostBadge: null, color: null, hidden: false }).children).toHaveLength(0)
  })

  it('hides both while the tab is being renamed', () => {
    expect(render({ hostBadge: 'builder', color: '#ff0000', hidden: true }).children).toHaveLength(
      0
    )
  })
})
