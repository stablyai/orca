// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyBrowserAutomationActivity,
  clearBrowserAutomationActivity
} from '@/lib/browser-automation-activity'
import {
  BrowserAutomationIndicator,
  BrowserAutomationTabIndicator
} from './BrowserAutomationIndicator'

function startAutomation(browserPageId: string, token = browserPageId): void {
  act(() => {
    applyBrowserAutomationActivity({
      browserPageId,
      token,
      active: true,
      expiresAt: Date.now() + 5000
    })
  })
}

describe('browser automation indicator', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    clearBrowserAutomationActivity()
  })

  afterEach(() => {
    cleanup()
    clearBrowserAutomationActivity()
    vi.useRealTimers()
  })

  it('stays absent for idle pages and marks only the page being automated', () => {
    const view = render(
      <>
        <BrowserAutomationIndicator browserPageId="page-a" />
        <BrowserAutomationIndicator browserPageId="page-b" />
      </>
    )
    expect(screen.queryByRole('status')).toBeNull()

    startAutomation('page-b')

    expect(screen.getAllByRole('status')).toHaveLength(1)
    expect(view.container.querySelector('[data-browser-automation-page-id="page-a"]')).toBeNull()
    expect(
      view.container.querySelector('[data-browser-automation-page-id="page-b"]')
    ).not.toBeNull()
    expect(screen.getByRole('status').textContent).toContain('Browser automation active')

    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('keeps focus in the current control and leaves browser input unobstructed', () => {
    const view = render(
      <>
        <input aria-label="Current control" />
        <BrowserAutomationIndicator browserPageId="page-a" />
      </>
    )
    const input = screen.getByRole('textbox')
    input.focus()
    startAutomation('page-a')

    expect(document.activeElement).toBe(input)
    const overlay = view.container.querySelector('[data-browser-automation-page-id="page-a"]')
    expect(overlay?.classList.contains('pointer-events-none')).toBe(true)
    expect(overlay?.querySelector('button, a, input, [tabindex]')).toBeNull()
    expect(overlay?.querySelector('.ring-inset')).not.toBeNull()
    expect(overlay?.querySelector('.motion-safe\\:animate-pulse')).not.toBeNull()
    expect(screen.getByRole('status').textContent).toBe('Browser automation active')
  })

  it('does not carry the previous page indicator into a different selected page', () => {
    startAutomation('page-a')
    const view = render(<BrowserAutomationIndicator browserPageId="page-a" />)
    expect(screen.getByRole('status')).toBeTruthy()

    view.rerender(<BrowserAutomationIndicator browserPageId="page-b" />)
    expect(screen.queryByRole('status')).toBeNull()

    view.rerender(<BrowserAutomationIndicator browserPageId={null} />)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('marks a workspace tab for background page activity without marking its selected page', () => {
    render(
      <>
        <div data-testid="workspace-tab">
          <BrowserAutomationTabIndicator browserPageIds={['page-a', 'page-b']} />
        </div>
        <BrowserAutomationIndicator browserPageId="page-a" />
      </>
    )
    startAutomation('unrelated-page')
    expect(screen.getByTestId('workspace-tab').textContent).toBe('')

    startAutomation('page-b')
    expect(screen.getByTestId('workspace-tab').textContent).toBe('Browser automation active')
    expect(screen.queryByRole('status')).toBeNull()

    act(() => {
      applyBrowserAutomationActivity({
        browserPageId: 'page-b',
        token: 'page-b',
        active: false,
        expiresAt: Date.now() + 5000
      })
    })
    expect(screen.getByTestId('workspace-tab').textContent).toBe('')
  })
})
