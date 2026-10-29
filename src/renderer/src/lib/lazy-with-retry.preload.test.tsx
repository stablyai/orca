// @vitest-environment happy-dom
import { act, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'

import { lazyWithPreload } from './lazy-with-retry'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

function Palette(): React.JSX.Element {
  return <input aria-label="palette" />
}

describe('lazyWithPreload', () => {
  it('renders a preloaded component in the same commit, without the Suspense fallback', async () => {
    const factory = vi.fn(() => Promise.resolve({ default: Palette }))
    const Preloadable = lazyWithPreload(factory)
    Preloadable.preload()
    await act(async () => {})

    const container = document.createElement('div')
    const root = createRoot(container)
    // A synchronous act flushes one render with no chance to retry a suspended one.
    act(() => {
      root.render(
        <Suspense fallback={<span>loading</span>}>
          <Preloadable />
        </Suspense>
      )
    })

    expect(container.querySelector('input[aria-label="palette"]')).not.toBeNull()
    expect(container.textContent).not.toContain('loading')
    expect(factory).toHaveBeenCalledTimes(1)
    act(() => root.unmount())
  })
})
