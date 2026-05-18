import { afterEach, describe, expect, it, vi } from 'vitest'
import { flashFocusedPaneRim, FOCUSED_PANE_FLASH_MS } from './focused-pane-rim-flash'

class MockClassList {
  private classes = new Set<string>()

  add(value: string): void {
    this.classes.add(value)
  }

  remove(value: string): void {
    this.classes.delete(value)
  }

  contains(value: string): boolean {
    return this.classes.has(value)
  }
}

function createPaneElement(): HTMLElement {
  return { classList: new MockClassList() } as unknown as HTMLElement
}

describe('flashFocusedPaneRim', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('removes the rim flash class after the highlight duration', () => {
    vi.useFakeTimers()
    const pane = createPaneElement()

    flashFocusedPaneRim(pane)

    expect(pane.classList.contains('pane-focus-rim-flash')).toBe(true)
    vi.advanceTimersByTime(FOCUSED_PANE_FLASH_MS)
    expect(pane.classList.contains('pane-focus-rim-flash')).toBe(false)
  })

  it('resets the removal timer when the same pane flashes again', () => {
    vi.useFakeTimers()
    const pane = createPaneElement()

    flashFocusedPaneRim(pane)
    vi.advanceTimersByTime(FOCUSED_PANE_FLASH_MS - 100)
    flashFocusedPaneRim(pane)
    vi.advanceTimersByTime(FOCUSED_PANE_FLASH_MS - 100)

    expect(pane.classList.contains('pane-focus-rim-flash')).toBe(true)
    vi.advanceTimersByTime(100)
    expect(pane.classList.contains('pane-focus-rim-flash')).toBe(false)
  })
})
