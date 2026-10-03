// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BaseRefPicker } from './BaseRefPicker'

const { getRuntimeRepoBaseRefDefault, searchRuntimeRepoBaseRefs } = vi.hoisted(() => ({
  getRuntimeRepoBaseRefDefault: vi.fn(),
  searchRuntimeRepoBaseRefs: vi.fn()
}))

vi.mock('@/runtime/runtime-repo-client', () => ({
  getRuntimeRepoBaseRefDefault,
  searchRuntimeRepoBaseRefs
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ activeRuntimeEnvironmentId: null, repos: [] })
}))

const RESULTS = ['origin/main', 'origin/develop', 'origin/release']
const scrollIntoView = vi.fn()
const SEARCH_DEBOUNCE_MS = 200

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.useFakeTimers()
  getRuntimeRepoBaseRefDefault.mockResolvedValue({ defaultBaseRef: 'origin/main', remoteCount: 1 })
  searchRuntimeRepoBaseRefs.mockResolvedValue(RESULTS)
  // Why: happy-dom does not implement scrollIntoView, which the active row calls.
  Element.prototype.scrollIntoView = scrollIntoView
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  vi.clearAllMocks()
  vi.useRealTimers()
})

async function render(onSelect: (ref: string) => void): Promise<void> {
  await act(async () => {
    root.render(React.createElement(BaseRefPicker, { repoId: 'repo-1', onSelect }))
  })
}

function getInput(): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input')
  if (!input) {
    throw new Error('base ref search input not found')
  }
  return input
}

function getOptions(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('[role="option"]'))
}

function getActiveOption(): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>('[role="option"][data-selected="true"]')
}

function refOf(option: HTMLButtonElement | null | undefined): string | undefined {
  // Why: the current base ref row also renders a "Current" badge after the ref.
  return option?.querySelector('span')?.textContent ?? undefined
}

function getActiveRef(): string | undefined {
  return refOf(getActiveOption())
}

async function typeQuery(text: string): Promise<void> {
  await act(async () => {
    const input = getInput()
    // Why: React reads controlled-input changes via the native value setter;
    // assigning input.value directly is swallowed by React's value tracking.
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setValue?.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function movePointerOver(index: number): Promise<void> {
  await act(async () => {
    getOptions()[index]?.dispatchEvent(new Event('pointermove', { bubbles: true }))
  })
}

function getScrollContainer(): HTMLElement {
  const list = container.querySelector<HTMLElement>('[role="listbox"]')?.parentElement
  if (!list) {
    throw new Error('results scroll container not found')
  }
  return list
}

async function settleSearch(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS)
  })
}

async function searchFor(text: string): Promise<void> {
  await typeQuery(text)
  await settleSearch()
}

async function pressKey(
  key: string,
  options: { isComposing?: boolean; keyCode?: number } = {}
): Promise<boolean> {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  if (options.isComposing !== undefined) {
    Object.defineProperty(event, 'isComposing', { value: options.isComposing })
  }
  if (options.keyCode !== undefined) {
    Object.defineProperty(event, 'keyCode', { value: options.keyCode })
  }
  await act(async () => {
    getInput().dispatchEvent(event)
  })
  return event.defaultPrevented
}

describe('BaseRefPicker keyboard navigation', () => {
  it('renders the search results as listbox options with no initial highlight', async () => {
    await render(vi.fn())
    await searchFor('origin')

    expect(getOptions().map(refOf)).toEqual(RESULTS)
    expect(getOptions().map((option) => option.getAttribute('aria-selected'))).toEqual([
      'true',
      'false',
      'false'
    ])
    expect(getActiveOption()).toBeNull()
    expect(getInput().getAttribute('aria-activedescendant')).toBeNull()
    expect(getInput().getAttribute('aria-label')).toBe('Base branch')
  })

  it('moves the highlight with ArrowDown and ArrowUp and mirrors it in aria-activedescendant', async () => {
    await render(vi.fn())
    await searchFor('origin')

    expect(await pressKey('ArrowDown')).toBe(true)
    expect(getActiveRef()).toBe('origin/main')
    expect(getInput().getAttribute('aria-activedescendant')).toBe(getActiveOption()?.id)

    await pressKey('ArrowDown')
    expect(getActiveRef()).toBe('origin/develop')

    expect(await pressKey('ArrowUp')).toBe(true)
    expect(getActiveRef()).toBe('origin/main')
    expect(getInput().getAttribute('aria-activedescendant')).toBe(getActiveOption()?.id)
  })

  it('scrolls the highlighted row into view as it moves', async () => {
    await render(vi.fn())
    await searchFor('origin')
    expect(scrollIntoView).not.toHaveBeenCalled()

    await pressKey('ArrowDown')
    await pressKey('ArrowDown')

    expect(scrollIntoView).toHaveBeenCalledTimes(2)
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: 'nearest' })
    expect(scrollIntoView.mock.contexts.at(-1)).toBe(getActiveOption())
  })

  it('shares one highlight between the pointer and the keyboard', async () => {
    const onSelect = vi.fn()
    await render(onSelect)
    await searchFor('origin')
    await pressKey('ArrowDown')
    scrollIntoView.mockClear()

    await movePointerOver(2)

    expect(getActiveRef()).toBe('origin/release')
    expect(container.querySelectorAll('[role="option"][data-selected="true"]')).toHaveLength(1)
    expect(scrollIntoView).not.toHaveBeenCalled()

    await pressKey('ArrowUp')
    expect(getActiveRef()).toBe('origin/develop')

    await movePointerOver(0)
    await pressKey('Enter')
    expect(onSelect).toHaveBeenCalledWith('origin/main')
  })

  it('clears the highlight when the pointer leaves the list', async () => {
    await render(vi.fn())
    await searchFor('origin')
    await movePointerOver(1)
    expect(getActiveRef()).toBe('origin/develop')

    await act(async () => {
      getScrollContainer().dispatchEvent(
        new MouseEvent('pointerout', { bubbles: true, relatedTarget: document.body })
      )
    })
    expect(getActiveOption()).toBeNull()

    await pressKey('ArrowDown')
    expect(getActiveRef()).toBe('origin/main')
  })

  it('moves the highlight to the row under a resting pointer when the list is wheel-scrolled', async () => {
    await render(vi.fn())
    await searchFor('origin')
    const list = getScrollContainer()
    Object.defineProperty(list, 'scrollHeight', { value: 500, configurable: true })
    Object.defineProperty(list, 'clientHeight', { value: 100, configurable: true })
    const elementFromPoint = vi.fn<(x: number, y: number) => Element | null>()
    document.elementFromPoint = elementFromPoint

    elementFromPoint.mockReturnValue(getOptions()[2]?.querySelector('span') ?? null)
    const wheel = new WheelEvent('wheel', { deltaY: 40, bubbles: true, cancelable: true })
    // Why: happy-dom's WheelEvent drops the pointer coordinates from its init.
    Object.defineProperty(wheel, 'clientX', { value: 12 })
    Object.defineProperty(wheel, 'clientY', { value: 34 })
    await act(async () => {
      list.dispatchEvent(wheel)
    })

    expect(wheel.defaultPrevented).toBe(true)
    expect(elementFromPoint).toHaveBeenCalledWith(12, 34)
    expect(getActiveRef()).toBe('origin/release')

    elementFromPoint.mockReturnValue(list)
    await act(async () => {
      list.dispatchEvent(new WheelEvent('wheel', { deltaY: 40, bubbles: true, cancelable: true }))
    })
    expect(getActiveOption()).toBeNull()
  })

  it('wraps the highlight at both ends of the list', async () => {
    await render(vi.fn())
    await searchFor('origin')

    await pressKey('ArrowUp')
    expect(getActiveRef()).toBe('origin/release')

    await pressKey('ArrowDown')
    expect(getActiveRef()).toBe('origin/main')
  })

  it('selects the highlighted ref on Enter and clears the search', async () => {
    const onSelect = vi.fn()
    await render(onSelect)
    await searchFor('origin')

    await pressKey('ArrowDown')
    await pressKey('ArrowDown')
    expect(await pressKey('Enter')).toBe(true)

    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith('origin/develop')
    expect(getInput().value).toBe('')
    expect(getOptions()).toEqual([])
  })

  it('does nothing on Enter when no result is highlighted', async () => {
    const onSelect = vi.fn()
    await render(onSelect)
    await searchFor('origin')

    expect(await pressKey('Enter')).toBe(false)

    expect(onSelect).not.toHaveBeenCalled()
    expect(getOptions()).toHaveLength(RESULTS.length)
  })

  it('ignores Enter while a search is still pending', async () => {
    const onSelect = vi.fn()
    await render(onSelect)
    await searchFor('origin')
    await pressKey('ArrowDown')

    await typeQuery('origin/dev')
    expect(getOptions()).toEqual([])
    expect(await pressKey('Enter')).toBe(false)

    expect(onSelect).not.toHaveBeenCalled()
  })

  it.each([
    ['isComposing', { isComposing: true }],
    ['keyCode 229', { keyCode: 229 }]
  ])('ignores the Enter that confirms an IME composition (%s)', async (_label, imeMark) => {
    const onSelect = vi.fn()
    await render(onSelect)
    await searchFor('origin')
    await pressKey('ArrowDown')

    expect(await pressKey('Enter', imeMark)).toBe(false)

    expect(onSelect).not.toHaveBeenCalled()
    expect(getActiveRef()).toBe('origin/main')
  })

  it.each([
    ['isComposing', { isComposing: true }],
    ['keyCode 229', { keyCode: 229 }]
  ])('leaves arrow keys to the IME during composition (%s)', async (_label, imeMark) => {
    await render(vi.fn())
    await searchFor('origin')
    await pressKey('ArrowDown')

    expect(await pressKey('ArrowDown', imeMark)).toBe(false)
    expect(await pressKey('ArrowUp', imeMark)).toBe(false)

    expect(getActiveRef()).toBe('origin/main')
  })

  it('resets the highlight when the search results change', async () => {
    await render(vi.fn())
    await searchFor('origin')
    await pressKey('ArrowDown')
    expect(getActiveRef()).toBe('origin/main')

    searchRuntimeRepoBaseRefs.mockResolvedValue(['origin/develop'])
    await searchFor('develop')

    expect(getOptions().map(refOf)).toEqual(['origin/develop'])
    expect(getActiveOption()).toBeNull()
  })

  it('still selects a ref on click', async () => {
    const onSelect = vi.fn()
    await render(onSelect)
    await searchFor('origin')

    await act(async () => {
      getOptions()[2]?.click()
    })

    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith('origin/release')
    expect(getInput().value).toBe('')
  })
})
