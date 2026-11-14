// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { TerminalPopoutOverlay } from './TerminalPopoutOverlay'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const focusMock = vi.fn()
const dockMock = vi.fn()

vi.mock('@/lib/workspace-popout/workspace-popout-state', () => ({
  focusTerminalTab: (worktreeId: string) => focusMock(worktreeId),
  dockTerminalTab: (worktreeId: string) => dockMock(worktreeId)
}))

describe('TerminalPopoutOverlay', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    vi.clearAllMocks()
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
  })

  it('renders title and triggers focus and dock handlers on click', async () => {
    await act(async () => {
      root.render(<TerminalPopoutOverlay worktreeId="wt-test" tabId="tab-123" />)
    })

    const overlay = container.querySelector('[data-testid="terminal-popout-overlay"]')
    expect(overlay).not.toBeNull()

    const buttons = container.querySelectorAll('button')
    expect(buttons.length).toBe(2)

    await act(async () => {
      buttons[0].click()
    })
    expect(focusMock).toHaveBeenCalledWith('wt-test')

    await act(async () => {
      buttons[1].click()
    })
    expect(dockMock).toHaveBeenCalledWith('wt-test')
  })
})
