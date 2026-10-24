// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useCallback, useRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { scrollTopCache } from '@/lib/scroll-cache'
import { useScrollTopCacheRestore } from './use-scroll-top-cache-restore'

type ScrollSurfaceProps = {
  cacheKey: string
  restoreKey: string
}

function configureScrollableSurface(surface: HTMLDivElement): void {
  Object.defineProperties(surface, {
    clientHeight: { configurable: true, value: 100 },
    scrollHeight: { configurable: true, value: 500 }
  })
}

function ScrollSurface({ cacheKey, restoreKey }: ScrollSurfaceProps): React.JSX.Element {
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const setSurfaceRef = useCallback((surface: HTMLDivElement | null) => {
    surfaceRef.current = surface
    if (surface) {
      configureScrollableSurface(surface)
    }
  }, [])

  useScrollTopCacheRestore(surfaceRef, cacheKey, restoreKey)

  return <div ref={setSurfaceRef} data-testid="scroll-surface" />
}

afterEach(() => {
  cleanup()
  scrollTopCache.clear()
  vi.useRealTimers()
})

describe('useScrollTopCacheRestore', () => {
  it('restores the cached position when the diagram surface mounts', () => {
    scrollTopCache.set('diagram', 180)

    render(<ScrollSurface cacheKey="diagram" restoreKey="first-diagram" />)

    expect(screen.getByTestId('scroll-surface').scrollTop).toBe(180)
  })

  it('stores the latest scroll position after the trailing delay', () => {
    vi.useFakeTimers()
    render(<ScrollSurface cacheKey="diagram" restoreKey="first-diagram" />)
    const surface = screen.getByTestId('scroll-surface')

    surface.scrollTop = 40
    fireEvent.scroll(surface)
    surface.scrollTop = 120
    fireEvent.scroll(surface)
    vi.advanceTimersByTime(150)

    expect(scrollTopCache.get('diagram')).toBe(120)
  })

  it('snapshots a scrollable surface when it unmounts', () => {
    const { unmount } = render(<ScrollSurface cacheKey="diagram" restoreKey="first-diagram" />)
    const surface = screen.getByTestId('scroll-surface')
    surface.scrollTop = 75

    unmount()

    expect(scrollTopCache.get('diagram')).toBe(75)
  })
})
