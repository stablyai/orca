// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SCROLL_TO_CURRENT_WORKSPACE_REVEAL_REQUEST_EVENT } from '@/lib/workspace/navigation/scroll-to-current-workspace-status'
import type { SidebarRevealNoneReason } from '../../../../../../shared/sidebar-list/sidebar-reveal-target'

const state = vi.hoisted(() => {
  const value: { reason: SidebarRevealNoneReason | null } = { reason: null }
  return value
})
vi.mock('../../sidebar-reveal-target-state', () => ({
  useSidebarRevealUnavailableReason: () => state.reason
}))

import { ScrollToCurrentWorkspaceToolbarButton } from './ScrollToCurrentWorkspaceToolbarButton'

const requests = vi.fn()

beforeEach(() => {
  state.reason = null
  requests.mockReset()
  window.addEventListener(SCROLL_TO_CURRENT_WORKSPACE_REVEAL_REQUEST_EVENT, requests)
})

afterEach(() => {
  window.removeEventListener(SCROLL_TO_CURRENT_WORKSPACE_REVEAL_REQUEST_EVENT, requests)
  cleanup()
})

function renderButton(): HTMLElement {
  render(
    <TooltipProvider>
      <ScrollToCurrentWorkspaceToolbarButton />
    </TooltipProvider>
  )
  return screen.getByRole('button')
}

describe('Reveal current button', () => {
  it('is named Reveal current and asks for a reveal on click', () => {
    const button = renderButton()
    expect(button.getAttribute('aria-label')).toBe('Reveal current')
    expect(button.getAttribute('aria-disabled')).toBeNull()
    fireEvent.click(button)
    expect(requests).toHaveBeenCalledTimes(1)
  })

  it('stays focusable without requesting a reveal when the workspace is unavailable', async () => {
    state.reason = 'archived'
    const text = 'Archived workspaces aren’t listed in the sidebar'
    const button = renderButton()
    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect(button.hasAttribute('disabled')).toBe(false)
    expect(button.getAttribute('aria-label')).toBe(`Reveal current. ${text}`)
    fireEvent.click(button)
    expect(requests).not.toHaveBeenCalled()
    // Focus opens its tooltip, which says why.
    await act(async () => {
      button.focus()
      fireEvent.focus(button)
    })
    expect(document.activeElement).toBe(button)
    expect((await screen.findAllByText(text)).length).toBeGreaterThan(0)
  })
})
