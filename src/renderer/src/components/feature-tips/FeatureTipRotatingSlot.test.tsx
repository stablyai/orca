// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FeatureTipRotatingSlot, ROTATING_SLOT_STEP_MS } from './FeatureTipRotatingSlot'

const ITEMS = ['Slack', 'Linear', 'GitHub'].map((label) => ({ key: label, label, icon: null }))

const STATIC = 'Slack, Linear or GitHub'

function reducedMotion(matches: boolean): void {
  vi.stubGlobal('matchMedia', () => ({
    matches,
    addEventListener: () => {},
    removeEventListener: () => {}
  }))
}

function track(container: HTMLElement): HTMLElement {
  const element = container.querySelector<HTMLElement>('[aria-hidden] > span')
  if (!element) {
    throw new Error('no track')
  }
  return element
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('feature tip rotating slot', () => {
  it('shows the static list with reduced motion and starts no timer', () => {
    vi.useFakeTimers()
    reducedMotion(true)
    const { container } = render(<FeatureTipRotatingSlot items={ITEMS} staticLabel={STATIC} />)
    expect(container.textContent).toBe(STATIC)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('starts after its delay, slides one name per step and snaps back from the copy of the first', () => {
    vi.useFakeTimers()
    reducedMotion(false)
    const { container, unmount } = render(
      <FeatureTipRotatingSlot items={ITEMS} staticLabel={STATIC} delayMs={900} />
    )
    // The list stays readable to screen readers while the names move.
    expect(container.querySelector('.sr-only')?.textContent).toBe(STATIC)
    expect(track(container).style.transform).toBe('translateY(0rem)')

    act(() => vi.advanceTimersByTime(900 + ROTATING_SLOT_STEP_MS))
    expect(track(container).style.transform).toBe('translateY(-1.25rem)')

    act(() => vi.advanceTimersByTime(ROTATING_SLOT_STEP_MS * 2))
    expect(track(container).style.transform).toBe('translateY(-3.75rem)')
    act(() => vi.advanceTimersByTime(600))
    expect(track(container).style.transform).toBe('translateY(0rem)')
    expect(track(container).style.transition).toBe('none')

    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('holds a single name still, with its icon', () => {
    vi.useFakeTimers()
    reducedMotion(false)
    const { container } = render(
      <FeatureTipRotatingSlot items={ITEMS.slice(0, 1)} staticLabel="Slack" />
    )
    expect(vi.getTimerCount()).toBe(0)
    expect(track(container).style.transform).toBe('translateY(0rem)')
  })
})
