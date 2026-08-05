// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store'
import { TooltipProvider } from '@/components/ui/tooltip'
import { CombinedDiffFileTreeHintButton } from './CombinedDiffFileTreeHintButton'
import { resetCombinedDiffFileTreeHintClaim } from './combined-diff-file-tree-hint-claim'

// Why the real Popover here: this covers the Tab-into-callout path, which only exists because
// the portaled content is otherwise unreachable from the trigger.
const mocks = vi.hoisted(() => ({ state: {} as Partial<AppState> }))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Partial<AppState>) => unknown) => selector(mocks.state)
}))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.useFakeTimers()
  mocks.state = {
    updateSettings: vi.fn(),
    dismissCombinedDiffFileTreeHint: vi.fn(),
    persistedUIReady: true,
    combinedDiffFileTreeHintDismissed: false,
    featureInteractions: {},
    settings: { combinedDiffFileTreeVisibleByDefault: false },
    activeContextualTourId: null,
    contextualToursOnboardingVisible: false,
    contextualToursBlockingSurfaceVisible: false
  } as unknown as Partial<AppState>
  resetCombinedDiffFileTreeHintClaim()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

describe('CombinedDiffFileTreeHintButton keyboard reach', () => {
  it('keeps focus on the diff until Tab moves it into the callout', () => {
    act(() => {
      root.render(
        <TooltipProvider>
          <CombinedDiffFileTreeHintButton
            label="Show file tree"
            surfaceActive
            fileTreeCollapsed
            sectionsLoaded
            changedFileCount={5}
            onSetFileTreeCollapsed={vi.fn()}
          />
        </TooltipProvider>
      )
    })
    act(() => {
      vi.advanceTimersByTime(600)
    })

    const trigger = container.querySelector('button[aria-label="Show file tree"]') as HTMLElement
    // Why: the callout is uninvited, so opening it must not steal focus from the diff.
    expect(document.activeElement).not.toBe(trigger)

    act(() => {
      trigger.focus()
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    })

    expect(document.activeElement?.getAttribute('role')).toBe('radio')
    expect(document.activeElement?.textContent).toBe('Shown')
  })
})
