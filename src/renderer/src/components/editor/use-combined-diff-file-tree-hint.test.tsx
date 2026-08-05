// @vitest-environment happy-dom

import React, { StrictMode, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetCombinedDiffFileTreeHintClaim } from './combined-diff-file-tree-hint-claim'
import { useCombinedDiffFileTreeHint } from './use-combined-diff-file-tree-hint'

const mocks = vi.hoisted(() => ({ dismiss: vi.fn() }))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: { dismissCombinedDiffFileTreeHint: () => void }) => unknown) =>
    selector({ dismissCombinedDiffFileTreeHint: mocks.dismiss })
}))

const HINT_DELAY_MS = 600

function Probe({
  eligible,
  surfaceActive,
  name
}: {
  eligible: boolean
  surfaceActive: boolean
  name: string
}): React.JSX.Element {
  const { hintOpen } = useCombinedDiffFileTreeHint({ eligible, surfaceActive })
  return <span data-probe={name}>{hintOpen ? 'open' : 'closed'}</span>
}

let container: HTMLDivElement
let root: Root

function render(node: React.ReactNode): void {
  act(() => {
    root.render(node)
  })
}

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

function probeStates(): string[] {
  return [...container.querySelectorAll('[data-probe]')].map((node) => node.textContent ?? '')
}

beforeEach(() => {
  vi.useFakeTimers()
  mocks.dismiss.mockClear()
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

describe('useCombinedDiffFileTreeHint', () => {
  it('opens once the settle delay elapses and persists the one-shot flag', () => {
    render(<Probe name="a" eligible surfaceActive />)
    expect(probeStates()).toEqual(['closed'])

    advance(HINT_DELAY_MS)

    expect(probeStates()).toEqual(['open'])
    expect(mocks.dismiss).toHaveBeenCalledTimes(1)
  })

  it('clears the pending timer when the viewer unmounts first', () => {
    render(<Probe name="a" eligible surfaceActive />)
    act(() => root.render(null))

    advance(HINT_DELAY_MS)

    expect(mocks.dismiss).not.toHaveBeenCalled()
  })

  it('drops the hint when eligibility disappears mid-timer, leaving the claim unspent', () => {
    render(<Probe name="a" eligible surfaceActive />)
    advance(HINT_DELAY_MS / 2)
    render(<Probe name="a" eligible={false} surfaceActive />)
    advance(HINT_DELAY_MS)

    expect(probeStates()).toEqual(['closed'])
    expect(mocks.dismiss).not.toHaveBeenCalled()

    render(<Probe name="a" eligible surfaceActive />)
    advance(HINT_DELAY_MS)

    expect(probeStates()).toEqual(['open'])
  })

  it('lets only one surface win the shared one-shot claim', () => {
    render(
      <>
        <Probe name="split-left" eligible surfaceActive />
        <Probe name="split-right" eligible surfaceActive />
      </>
    )

    advance(HINT_DELAY_MS)

    expect(probeStates().filter((state) => state === 'open')).toHaveLength(1)
    expect(mocks.dismiss).toHaveBeenCalledTimes(1)
  })

  it('shows once under StrictMode double-invoked effects', () => {
    render(
      <StrictMode>
        <Probe name="a" eligible surfaceActive />
      </StrictMode>
    )

    advance(HINT_DELAY_MS)

    expect(probeStates()).toEqual(['open'])
    expect(mocks.dismiss).toHaveBeenCalledTimes(1)
  })

  it('closes when the surface is hidden and never re-opens on return', () => {
    render(<Probe name="a" eligible surfaceActive />)
    advance(HINT_DELAY_MS)
    expect(probeStates()).toEqual(['open'])

    render(<Probe name="a" eligible={false} surfaceActive={false} />)
    expect(probeStates()).toEqual(['closed'])

    render(<Probe name="a" eligible={false} surfaceActive />)
    advance(HINT_DELAY_MS)

    expect(probeStates()).toEqual(['closed'])
  })
})
