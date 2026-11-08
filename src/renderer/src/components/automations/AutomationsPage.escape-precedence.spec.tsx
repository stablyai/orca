// @vitest-environment happy-dom

/** Window capture runs before Radix document capture; preventing Escape here would veto dismissal of an overlaid dialog (STA-5207). */

import { describe, expect, it, vi } from 'vitest'
import {
  installAutomationsPageHarness,
  mocks,
  renderPage,
  settleHostQueries
} from './automations-page-test-harness'

function pressEscape(target: EventTarget): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event
}

async function renderWithCloseSpy(): Promise<ReturnType<typeof vi.fn>> {
  const closeAutomationsPage = vi.fn()
  mocks.state.closeAutomationsPage = closeAutomationsPage
  await renderPage()
  await settleHostQueries()
  return closeAutomationsPage
}

describe('automations page Escape precedence', () => {
  installAutomationsPageHarness()

  it('closes the page when nothing is layered above it', async () => {
    const closeAutomationsPage = await renderWithCloseSpy()

    const event = pressEscape(document.body)

    expect(event.defaultPrevented).toBe(true)
    expect(closeAutomationsPage).toHaveBeenCalledTimes(1)
  })

  it('leaves Escape to a store modal opened over the page', async () => {
    mocks.state.activeModal = 'new-workspace-composer'
    const closeAutomationsPage = await renderWithCloseSpy()
    const input = document.createElement('input')
    document.body.appendChild(input)

    const event = pressEscape(input)

    expect(event.defaultPrevented).toBe(false)
    expect(closeAutomationsPage).not.toHaveBeenCalled()
  })

  it('leaves Escape to a store modal even when focus is on page chrome', async () => {
    mocks.state.activeModal = 'worktree-palette'
    const closeAutomationsPage = await renderWithCloseSpy()

    const event = pressEscape(document.body)

    expect(event.defaultPrevented).toBe(false)
    expect(closeAutomationsPage).not.toHaveBeenCalled()
  })

  it('leaves Escape to a visible overlay that the store does not track', async () => {
    const closeAutomationsPage = await renderWithCloseSpy()
    const overlay = document.createElement('div')
    overlay.setAttribute('role', 'dialog')
    document.body.appendChild(overlay)

    const event = pressEscape(document.body)

    expect(event.defaultPrevented).toBe(false)
    expect(closeAutomationsPage).not.toHaveBeenCalled()
  })
})
