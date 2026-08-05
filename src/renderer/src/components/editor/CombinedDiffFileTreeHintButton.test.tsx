// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { AppState } from '@/store'
import { CombinedDiffFileTreeHintButton } from './CombinedDiffFileTreeHintButton'
import { resetCombinedDiffFileTreeHintClaim } from './combined-diff-file-tree-hint-claim'

const mocks = vi.hoisted(() => ({
  updateSettings: vi.fn(),
  dismissCombinedDiffFileTreeHint: vi.fn(),
  tooltipOpen: undefined as boolean | undefined,
  popoverOpen: false,
  state: {} as Partial<AppState>
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Partial<AppState>) => unknown) => selector(mocks.state)
}))

vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children, open }: { children: ReactNode; open?: boolean }) => {
    mocks.popoverOpen = open === true
    return <div>{children}</div>
  },
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: ReactNode }) =>
    mocks.popoverOpen ? <div data-callout>{children}</div> : null
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children, open }: { children: ReactNode; open?: boolean }) => {
    mocks.tooltipOpen = open
    return <>{children}</>
  },
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <span>{children}</span>
}))

const HINT_DELAY_MS = 600

let container: HTMLDivElement
let root: Root
let onSetFileTreeCollapsed: Mock<(collapsed: boolean) => void>

function renderButton(overrides: { changedFileCount?: number } = {}): void {
  act(() => {
    root.render(
      <CombinedDiffFileTreeHintButton
        label="Show file tree"
        surfaceActive
        fileTreeCollapsed
        sectionsLoaded
        changedFileCount={overrides.changedFileCount ?? 5}
        onSetFileTreeCollapsed={onSetFileTreeCollapsed}
      />
    )
  })
}

function openCallout(): void {
  act(() => {
    vi.advanceTimersByTime(HINT_DELAY_MS)
  })
}

function calloutButton(text: string): HTMLElement {
  const match = [...container.querySelectorAll('[data-callout] button')].find(
    (node) => node.textContent === text
  )
  if (!match) {
    throw new Error(`No callout button labelled ${text}`)
  }
  return match as HTMLElement
}

function click(node: HTMLElement): void {
  act(() => {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  mocks.updateSettings.mockClear()
  mocks.dismissCombinedDiffFileTreeHint.mockClear()
  mocks.tooltipOpen = undefined
  mocks.popoverOpen = false
  mocks.state = {
    updateSettings: mocks.updateSettings,
    dismissCombinedDiffFileTreeHint: mocks.dismissCombinedDiffFileTreeHint,
    persistedUIReady: true,
    combinedDiffFileTreeHintDismissed: false,
    featureInteractions: {},
    settings: { combinedDiffFileTreeVisibleByDefault: false },
    activeContextualTourId: null,
    contextualToursOnboardingVisible: false,
    contextualToursBlockingSurfaceVisible: false
  } as unknown as Partial<AppState>
  resetCombinedDiffFileTreeHintClaim()
  onSetFileTreeCollapsed = vi.fn<(collapsed: boolean) => void>()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

describe('CombinedDiffFileTreeHintButton', () => {
  it('opens the callout for an eligible diff', () => {
    renderButton()
    expect(container.querySelector('[data-callout]')).toBeNull()

    openCallout()

    expect(container.querySelector('[data-callout]')).not.toBeNull()
    expect(mocks.dismissCombinedDiffFileTreeHint).toHaveBeenCalledTimes(1)
  })

  it('points the trigger at the callout text so the uninvited layer is announced', () => {
    renderButton()
    openCallout()

    const describedBy = container
      .querySelector('button[aria-label="Show file tree"]')
      ?.getAttribute('aria-describedby')

    expect(describedBy).toBeTruthy()
    expect(container.querySelector(`[data-callout] #${CSS.escape(describedBy!)}`)).not.toBeNull()
  })

  it('stays quiet on a diff too small to need a tree', () => {
    renderButton({ changedFileCount: 2 })
    openCallout()

    expect(container.querySelector('[data-callout]')).toBeNull()
    expect(mocks.dismissCombinedDiffFileTreeHint).not.toHaveBeenCalled()
  })

  it('stays quiet while a contextual tour owns the screen', () => {
    mocks.state = {
      ...mocks.state,
      activeContextualTourId: 'workspace-agent-sessions'
    } as unknown as Partial<AppState>
    renderButton()
    openCallout()

    expect(container.querySelector('[data-callout]')).toBeNull()
    expect(mocks.dismissCombinedDiffFileTreeHint).not.toHaveBeenCalled()
  })

  it('suppresses the button tooltip while the callout explains the same button', () => {
    renderButton()
    expect(mocks.tooltipOpen).toBe(false)

    openCallout()

    expect(mocks.tooltipOpen).toBe(false)
  })

  it('saves the shown default and reveals the tree immediately', () => {
    renderButton()
    openCallout()

    click(calloutButton('Shown'))

    expect(mocks.updateSettings).toHaveBeenCalledWith({
      combinedDiffFileTreeVisibleByDefault: true
    })
    expect(onSetFileTreeCollapsed).toHaveBeenCalledWith(false)
    expect(container.querySelector('[data-callout]')).toBeNull()
  })

  it('saves the hidden default without opening the tree', () => {
    renderButton()
    openCallout()

    click(calloutButton('Hidden'))

    expect(mocks.updateSettings).toHaveBeenCalledWith({
      combinedDiffFileTreeVisibleByDefault: false
    })
    expect(onSetFileTreeCollapsed).not.toHaveBeenCalled()
    expect(container.querySelector('[data-callout]')).toBeNull()
  })

  it('changes no setting when the callout is dismissed', () => {
    renderButton()
    openCallout()

    click(calloutButton('Dismiss'))

    expect(mocks.updateSettings).not.toHaveBeenCalled()
    expect(onSetFileTreeCollapsed).not.toHaveBeenCalled()
    expect(container.querySelector('[data-callout]')).toBeNull()
  })

  it('still opens the tree when the trigger itself is clicked', () => {
    renderButton()
    openCallout()

    click(container.querySelector('button[aria-label="Show file tree"]') as HTMLElement)

    expect(onSetFileTreeCollapsed).toHaveBeenCalledWith(false)
    expect(container.querySelector('[data-callout]')).toBeNull()
  })
})
