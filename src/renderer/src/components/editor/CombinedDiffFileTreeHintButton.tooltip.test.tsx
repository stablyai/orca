// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store'
import { TooltipProvider } from '@/components/ui/tooltip'
import { CombinedDiffFileTreeHintButton } from './CombinedDiffFileTreeHintButton'
import { resetCombinedDiffFileTreeHintClaim } from './combined-diff-file-tree-hint-claim'

// Why the real Tooltip here: Radix only warns about a controlled/uncontrolled switch from
// inside its own hook, so a mocked Tooltip cannot catch it.
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

function dismissButton(): HTMLElement {
  const match = [...document.body.querySelectorAll('button')].find(
    (node) => node.textContent === 'Dismiss'
  )
  if (!match) {
    throw new Error('No Dismiss button in the callout')
  }
  return match
}

describe('CombinedDiffFileTreeHintButton tooltip lifecycle', () => {
  it('never switches the tooltip between controlled and uncontrolled', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

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
    act(() => {
      dismissButton().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(
      warn.mock.calls.filter(([message]) => String(message).includes('uncontrolled'))
    ).toHaveLength(0)
    warn.mockRestore()
  })
})
