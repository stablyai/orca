// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'

const clock = vi.hoisted(() => ({ now: 1_000_000 }))

vi.mock('@/hooks/use-now', () => ({
  useNow: () => clock.now
}))

import { EventTime } from './activity-thread-controls'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

describe('EventTime shared-clock refresh', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    document.body.replaceChildren()
  })

  it('derives the label from the shared clock, not a frozen render-time Date.now()', () => {
    // Why: memo'd rows no longer re-render on unrelated store writes, so the label
    // must follow the injected clock or "2m" would freeze at whatever render saw.
    const timestamp = clock.now - 2 * 60_000
    const render = (): void => {
      act(() => {
        root.render(
          <TooltipProvider>
            <EventTime timestamp={timestamp} compact />
          </TooltipProvider>
        )
      })
    }
    render()
    expect(container.textContent).toContain('2m')

    clock.now += 8 * 60_000
    render()
    expect(container.textContent).toContain('10m')
  })
})
