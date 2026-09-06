// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DiffNavigationProvider,
  useDiffNavigatorRegistration,
  useDiffNavigation,
  type DiffNavigator,
  type DiffNavigatorRegistrationContextValue,
  type DiffNavigationContextValue
} from './diff-navigation-context'

type FakeNavigator = DiffNavigator & {
  scrollToChange: DiffNavigator['scrollToChange'] & { mock: unknown }
}

function createFakeNavigator(changeLines: number[]): FakeNavigator {
  return {
    changeLines,
    container: document.createElement('div'),
    scrollToChange: vi.fn<DiffNavigator['scrollToChange']>()
  } as FakeNavigator
}

let captured: DiffNavigationContextValue | null = null
let registration: DiffNavigatorRegistrationContextValue | null = null
let registrationRenderCount = 0

function Probe(): null {
  captured = useDiffNavigation()
  return null
}

function RegistrationProbe(): null {
  registration = useDiffNavigatorRegistration()
  registrationRenderCount += 1
  return null
}

describe('DiffNavigationProvider', () => {
  let container: HTMLDivElement | null = null
  let root: Root | null = null

  function mount(): void {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => {
      root?.render(
        <DiffNavigationProvider>
          <Probe />
          <RegistrationProbe />
        </DiffNavigationProvider>
      )
    })
  }

  afterEach(() => {
    if (root) {
      act(() => root?.unmount())
    }
    container?.remove()
    container = null
    root = null
    captured = null
    registration = null
    registrationRenderCount = 0
  })

  it('exposes the change count and routes nav actions to the registered navigator', () => {
    mount()
    const navigator = createFakeNavigator([4, 20, 61])
    act(() => registration?.registerDiffNavigator(navigator))

    expect(captured?.changeCount).toBe(3)

    act(() => captured?.goToNextDiff())
    expect(navigator.scrollToChange).toHaveBeenCalledWith({
      lineNumber: 4,
      hunkIndex: 0,
      hunkCount: 3
    })

    act(() => captured?.goToNextDiff())
    expect(navigator.scrollToChange).toHaveBeenLastCalledWith({
      lineNumber: 20,
      hunkIndex: 1,
      hunkCount: 3
    })
  })

  it('wraps the cursor at both ends', () => {
    mount()
    const navigator = createFakeNavigator([4, 20])
    act(() => registration?.registerDiffNavigator(navigator))

    // Previous from the initial position lands on the last change.
    act(() => captured?.goToPreviousDiff())
    expect(navigator.scrollToChange).toHaveBeenLastCalledWith({
      lineNumber: 20,
      hunkIndex: 1,
      hunkCount: 2
    })

    act(() => captured?.goToNextDiff())
    expect(navigator.scrollToChange).toHaveBeenLastCalledWith({
      lineNumber: 4,
      hunkIndex: 0,
      hunkCount: 2
    })
  })

  it('does nothing when the registered navigator has no changes', () => {
    mount()
    const navigator = createFakeNavigator([])
    act(() => registration?.registerDiffNavigator(navigator))

    expect(captured?.changeCount).toBe(0)
    act(() => captured?.goToNextDiff())
    expect(navigator.scrollToChange).not.toHaveBeenCalled()
  })

  it('ignores a stale unregister for a navigator that is no longer current (identity guard)', () => {
    mount()
    const oldNavigator = createFakeNavigator([1])
    const newNavigator = createFakeNavigator([2, 3, 4, 5])

    // Fast-swap: new navigator registers before the old one's teardown fires.
    act(() => registration?.registerDiffNavigator(oldNavigator))
    act(() => registration?.registerDiffNavigator(newNavigator))
    expect(captured?.changeCount).toBe(4)

    act(() => registration?.unregisterDiffNavigator(oldNavigator))

    // New navigator's count is intact and nav still routes to it.
    expect(captured?.changeCount).toBe(4)
    act(() => captured?.goToNextDiff())
    expect(newNavigator.scrollToChange).toHaveBeenCalledOnce()
    expect(oldNavigator.scrollToChange).not.toHaveBeenCalled()
  })

  it('keeps the registration context identity stable across count changes', () => {
    mount()
    act(() => registration?.registerDiffNavigator(createFakeNavigator([1, 2])))
    expect(captured?.changeCount).toBe(2)
    expect(registrationRenderCount).toBe(1)
  })

  it('installs a capture-phase key listener on register and removes it on unregister', () => {
    mount()
    const navigator = createFakeNavigator([2])
    const addSpy = vi.spyOn(navigator.container, 'addEventListener')
    const removeSpy = vi.spyOn(navigator.container, 'removeEventListener')

    act(() => registration?.registerDiffNavigator(navigator))
    expect(addSpy).toHaveBeenCalledWith('keydown', expect.any(Function), true)

    act(() => registration?.unregisterDiffNavigator(navigator))
    expect(removeSpy).toHaveBeenCalledWith('keydown', expect.any(Function), true)
  })

  it('removes the key listener when the provider unmounts', () => {
    mount()
    const navigator = createFakeNavigator([1])
    const removeSpy = vi.spyOn(navigator.container, 'removeEventListener')
    act(() => registration?.registerDiffNavigator(navigator))

    act(() => root?.unmount())

    expect(removeSpy).toHaveBeenCalledWith('keydown', expect.any(Function), true)
    root = null
  })
})
