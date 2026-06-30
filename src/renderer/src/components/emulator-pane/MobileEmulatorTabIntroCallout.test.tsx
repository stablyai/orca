// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MobileEmulatorTabIntroCallout } from './MobileEmulatorTabIntroCallout'

const { keepIntro, hideIntro, dismissIntro } = vi.hoisted(() => ({
  keepIntro: vi.fn(),
  hideIntro: vi.fn(),
  dismissIntro: vi.fn()
}))

vi.mock('./use-mobile-emulator-tab-intro-actions', () => ({
  useMobileEmulatorTabIntroActions: () => ({ keepIntro, hideIntro, dismissIntro })
}))

// Why: the Tooltip primitive needs a provider/portal we don't care about here;
// render its trigger children directly so the test stays focused on wiring.
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => children,
  TooltipContent: () => null
}))

let root: Root | null = null
let container: HTMLDivElement | null = null

beforeEach(async () => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(<MobileEmulatorTabIntroCallout />)
  })
})

afterEach(async () => {
  if (root) {
    await act(async () => {
      root?.unmount()
    })
  }
  root = null
  container?.remove()
  container = null
  vi.clearAllMocks()
})

function click(matcher: string): void {
  const button = Array.from(container?.querySelectorAll('button') ?? []).find(
    (el) => el.textContent?.trim() === matcher || el.getAttribute('aria-label') === matcher
  )
  if (!button) {
    throw new Error(`button not found: ${matcher}`)
  }
  act(() => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('MobileEmulatorTabIntroCallout', () => {
  it('runs keepIntro when Keep is clicked', () => {
    click('Keep')
    expect(keepIntro).toHaveBeenCalledTimes(1)
    expect(hideIntro).not.toHaveBeenCalled()
    expect(dismissIntro).not.toHaveBeenCalled()
  })

  it('runs hideIntro when Hide is clicked', () => {
    click('Hide')
    expect(hideIntro).toHaveBeenCalledTimes(1)
    expect(keepIntro).not.toHaveBeenCalled()
    expect(dismissIntro).not.toHaveBeenCalled()
  })

  it('runs dismissIntro when the X is clicked', () => {
    click('Dismiss')
    expect(dismissIntro).toHaveBeenCalledTimes(1)
    expect(keepIntro).not.toHaveBeenCalled()
    expect(hideIntro).not.toHaveBeenCalled()
  })

  it('exposes no menu-closing prop, so reintroducing Issue 1 is a compile error', () => {
    // Why: Issue 1's root cause was a parent-supplied close callback
    // (onAction={() => setNewTabMenuOpen(false)}). The callout must accept no
    // such prop — re-adding one fails this typechecked file's @ts-expect-error.
    // @ts-expect-error - MobileEmulatorTabIntroCallout intentionally takes no props
    const reintroduced = <MobileEmulatorTabIntroCallout onAction={() => undefined} />
    expect(reintroduced).toBeDefined()
  })

  it('prevents the default pointer-down so the dropdown menu stays open', () => {
    const callout = container?.querySelector('.mobile-emulator-tab-intro-callout--menu')
    expect(callout).not.toBeNull()
    const event = new MouseEvent('pointerdown', { bubbles: true, cancelable: true })
    act(() => {
      callout?.dispatchEvent(event)
    })
    expect(event.defaultPrevented).toBe(true)
  })
})
