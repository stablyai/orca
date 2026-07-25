// @vitest-environment happy-dom

import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorktreeCardDetailsHover } from './WorktreeCardMeta'
import {
  useWorktreeCardDetailsHoverControl,
  type WorktreeCardDetailsHoverControl
} from './worktree-card-details-hover-state'
import {
  calibrateHostPointerOrigin,
  resetHostPointerOriginForTests
} from '@/hooks/webview-leaked-pointer-guard'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

describe('WorktreeCardDetailsHover focus handling', () => {
  let container: HTMLDivElement
  let root: Root
  let control: WorktreeCardDetailsHoverControl | null = null

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
    control = null
    resetHostPointerOriginForTests()
  })

  function Harness(): React.JSX.Element {
    const hoverControl = useWorktreeCardDetailsHoverControl()
    useEffect(() => {
      control = hoverControl
    })
    return (
      <WorktreeCardDetailsHover
        issue={null}
        linearIssue={null}
        review={null}
        comment={null}
        automationProvenance={null}
        automationHostId={undefined}
        branchName="feat/KRB-1823-condition-guard-event-labels"
        workspaceTitle="Debug cjv3 20k users"
        openDelay={0}
        closeDelay={0}
        hoverControl={hoverControl}
      >
        <div data-testid="trigger">
          <button type="button" data-testid="inner">
            delete workspace
          </button>
        </div>
      </WorktreeCardDetailsHover>
    )
  }

  function mountHarness(): void {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    act(() => {
      root.render(<Harness />)
    })
  }

  async function settleOpenDelay(): Promise<void> {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
  }

  // Captured from a real drag-select: window origin (459,25), webview origin (281,87).
  const WINDOW_ORIGIN = { x: 459, y: 25 }
  const WEBVIEW_ORIGIN = { x: 281, y: 87 }

  function calibrate(): void {
    calibrateHostPointerOrigin(
      {
        clientX: 186,
        clientY: 620,
        screenX: 186 + WINDOW_ORIGIN.x,
        screenY: 620 + WINDOW_ORIGIN.y
      },
      { authoritative: true }
    )
  }

  async function enterTrigger(init: {
    clientX: number
    clientY: number
    screenX: number
    screenY: number
  }): Promise<void> {
    const trigger = container.querySelector<HTMLElement>('[data-testid="trigger"]')
    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent('pointerover', { ...init, bubbles: true, buttons: 0 }))
    })
    await settleOpenDelay()
  }

  it('opens when the pointer really is over the card', async () => {
    mountHarness()
    calibrate()

    await enterTrigger({
      clientX: 140,
      clientY: 60,
      screenX: 140 + WINDOW_ORIGIN.x,
      screenY: 60 + WINDOW_ORIGIN.y
    })

    expect(control?.hoverOpen).toBe(true)
  })

  it('ignores a webview-leaked enter carrying guest-local coordinates', async () => {
    mountHarness()
    calibrate()

    // Why: the captured leak — client says 129,60 in the sidebar while screen says the pointer is
    // really inside the browser pane, one webview origin away.
    await enterTrigger({
      clientX: 129,
      clientY: 60,
      screenX: 129 + WINDOW_ORIGIN.x + WEBVIEW_ORIGIN.x,
      screenY: 60 + WINDOW_ORIGIN.y + WEBVIEW_ORIGIN.y
    })

    expect(control?.hoverOpen).toBe(false)
  })

  it('does not open when focus lands on a control inside the card', async () => {
    mountHarness()

    const inner = container.querySelector<HTMLButtonElement>('[data-testid="inner"]')
    await act(async () => {
      inner?.dispatchEvent(new Event('focusin', { bubbles: true }))
    })
    await settleOpenDelay()

    expect(control?.hoverOpen).toBe(false)
  })

  it('still opens when the trigger itself takes focus', async () => {
    mountHarness()

    const trigger = container.querySelector<HTMLElement>('[data-testid="trigger"]')
    await act(async () => {
      trigger?.dispatchEvent(new Event('focusin', { bubbles: true }))
    })
    await settleOpenDelay()

    expect(control?.hoverOpen).toBe(true)
  })
})
