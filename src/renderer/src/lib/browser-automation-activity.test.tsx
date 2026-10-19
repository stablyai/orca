// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyBrowserAutomationActivity,
  clearBrowserAutomationActivity,
  isBrowserAutomationActive,
  rememberAutomationBrowserPage,
  useBrowserAutomationActive,
  useBrowserAutomationPageIds
} from './browser-automation-activity'

function activity(browserPageId: string, token: string, active = true, lifetime = 30_000) {
  return { browserPageId, token, active, expiresAt: Date.now() + lifetime }
}

function Status({ pageId }: { pageId: string }) {
  const active = useBrowserAutomationActive(pageId)
  return <span data-testid={pageId}>{active ? 'active' : 'idle'}</span>
}

describe('browser automation activity', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    cleanup()
    clearBrowserAutomationActivity()
    vi.useRealTimers()
  })

  it('updates only the targeted page and preserves overlapping operations', () => {
    render(
      <>
        <Status pageId="page-a" />
        <Status pageId="page-b" />
      </>
    )
    act(() => {
      applyBrowserAutomationActivity(activity('page-a', 'a1'))
      applyBrowserAutomationActivity(activity('page-a', 'a2'))
    })
    expect(screen.getByTestId('page-a').textContent).toBe('active')
    expect(screen.getByTestId('page-b').textContent).toBe('idle')
    act(() => applyBrowserAutomationActivity(activity('page-a', 'a1', false)))
    expect(screen.getByTestId('page-a').textContent).toBe('active')
    act(() => applyBrowserAutomationActivity(activity('page-a', 'a2', false)))
    expect(screen.getByTestId('page-a').textContent).toBe('idle')
  })

  it('expires missing releases and renews long operations without counting them twice', () => {
    applyBrowserAutomationActivity(activity('page-a', 'a1'))
    vi.advanceTimersByTime(20_000)
    applyBrowserAutomationActivity(activity('page-a', 'a1'))
    vi.advanceTimersByTime(20_000)
    expect(isBrowserAutomationActive('page-a')).toBe(true)
    vi.advanceTimersByTime(10_000)
    expect(isBrowserAutomationActive('page-a')).toBe(false)
    applyBrowserAutomationActivity(activity('page-a', 'a1', false))
    expect(isBrowserAutomationActive('page-a')).toBe(false)
  })

  it('ignores releases for another page and refuses invalid or expired leases', () => {
    applyBrowserAutomationActivity(activity('page-a', 'a1'))
    applyBrowserAutomationActivity(activity('page-b', 'a1', false))
    applyBrowserAutomationActivity(activity('page-c', 'c1', true, -1))
    applyBrowserAutomationActivity({ ...activity('page-d', 'd1'), expiresAt: Number.NaN })
    expect(isBrowserAutomationActive('page-a')).toBe(true)
    expect(isBrowserAutomationActive('page-b')).toBe(false)
    expect(isBrowserAutomationActive('page-c')).toBe(false)
    expect(isBrowserAutomationActive('page-d')).toBe(false)
  })

  it('clears leases and pending expiry timers when its IPC subscription ends', () => {
    applyBrowserAutomationActivity(activity('page-a', 'a1'))
    applyBrowserAutomationActivity(activity('page-b', 'b1'))
    clearBrowserAutomationActivity()
    expect(isBrowserAutomationActive('page-a')).toBe(false)
    expect(isBrowserAutomationActive('page-b')).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds an unexpectedly long lease if the producer stops renewing it', () => {
    applyBrowserAutomationActivity(activity('page-a', 'a1', true, 24 * 60 * 60 * 1_000))
    vi.advanceTimersByTime(60_000)
    expect(isBrowserAutomationActive('page-a')).toBe(false)
  })

  it('remembers opened pages after activity ends, without duplicating or retaining unbounded history', () => {
    function Pages() {
      return <span data-testid="pages">{JSON.stringify(useBrowserAutomationPageIds())}</span>
    }
    render(<Pages />)
    act(() => {
      for (let index = 0; index < 130; index += 1) {
        rememberAutomationBrowserPage(`opened-${index}`)
      }
      rememberAutomationBrowserPage('opened-129')
    })
    const ids: unknown = JSON.parse(screen.getByTestId('pages').textContent ?? '[]')
    expect(ids).toHaveLength(128)
    expect(ids).not.toContain('opened-0')
    expect(ids).toContain('opened-129')
    act(() => {
      applyBrowserAutomationActivity(activity('opened-129', 'opened-token'))
      applyBrowserAutomationActivity(activity('opened-129', 'opened-token', false))
    })
    expect(screen.getByTestId('pages').textContent).toContain('opened-129')
  })
})
