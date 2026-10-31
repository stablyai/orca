/**
 * @vitest-environment happy-dom
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TabDragLeafTarget } from './tab-drag-leaf-target'
import TabLeafDropOverlay from './TabLeafDropOverlay'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

const mounted: { container: HTMLDivElement; root: Root }[] = []

const target: TabDragLeafTarget = {
  groupId: 'group-1',
  targetTabId: 'tab-target',
  leafId: 'leaf-c',
  zone: 'right',
  side: 'right',
  leafRect: { left: 100, top: 50, width: 400, height: 300 },
  refusal: null
}

function render(next: TabDragLeafTarget): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => root.render(<TabLeafDropOverlay target={next} />))
  mounted.push({ container, root })
  const overlay = document.body.querySelector<HTMLElement>('[data-leaf-drop-overlay]')
  if (!overlay) {
    throw new Error('Missing leaf drop overlay')
  }
  return overlay
}

afterEach(() => {
  for (const { container, root } of mounted.splice(0)) {
    act(() => root.unmount())
    container.remove()
  }
  document.body.replaceChildren()
})

describe('TabLeafDropOverlay', () => {
  it.each([
    ['left', { left: '100px', top: '50px', width: '200px', height: '300px' }],
    ['right', { left: '300px', top: '50px', width: '200px', height: '300px' }],
    ['up', { left: '100px', top: '50px', width: '400px', height: '150px' }],
    ['down', { left: '100px', top: '200px', width: '400px', height: '150px' }]
  ] as const)('covers the %s half of the pane and says "Join tab"', (zone, box) => {
    const overlay = render({
      ...target,
      zone,
      side: zone === 'up' ? 'top' : zone === 'down' ? 'bottom' : zone
    })

    expect(overlay.style.left).toBe(box.left)
    expect(overlay.style.top).toBe(box.top)
    expect(overlay.style.width).toBe(box.width)
    expect(overlay.style.height).toBe(box.height)
    expect(overlay.textContent).toBe('Join tab')
    expect(overlay.hasAttribute('data-disabled')).toBe(false)
  })

  it('shows a refused target as disabled, with the reason instead of the label', () => {
    const overlay = render({ ...target, refusal: 'target_chat' })

    expect(overlay.hasAttribute('data-disabled')).toBe(true)
    expect(overlay.textContent).toBe('Chat view')
  })

  it('lets the pointer through to what is under it', () => {
    expect(render(target).className).toContain('pointer-events-none')
  })
})
