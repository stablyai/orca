// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { scrollTopCache } from '@/lib/scroll-cache'
import { useIpynbScrollRestoration } from './useIpynbScrollRestoration'

function NotebookScrollSurface({ ready }: { ready: boolean }) {
  const rootRef = useRef<HTMLDivElement>(null)
  useIpynbScrollRestoration(rootRef, 'notebook', ready)
  return ready ? <div ref={rootRef} data-testid="notebook" /> : null
}

beforeEach(() => {
  vi.useFakeTimers()
  scrollTopCache.clear()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  scrollTopCache.clear()
})

describe('notebook scroll restoration', () => {
  it('remembers scroll when invalid source becomes a notebook without remounting the viewer', () => {
    const view = render(<NotebookScrollSurface ready={false} />)
    view.rerender(<NotebookScrollSurface ready />)
    const notebook = screen.getByTestId('notebook')
    notebook.scrollTop = 500
    fireEvent.scroll(notebook)
    vi.advanceTimersByTime(150)
    expect(scrollTopCache.get('notebook')).toBe(500)

    view.unmount()
    render(<NotebookScrollSurface ready />)
    expect(screen.getByTestId('notebook').scrollTop).toBe(500)
  })
})
