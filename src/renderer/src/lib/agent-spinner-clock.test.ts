import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_SPINNER_TICK_MS,
  registerAgentSpinnerElement,
  resetAgentSpinnerClockForTesting
} from './agent-spinner-clock'
import { resetStaleDocumentVisibilityForTesting } from '@/components/terminal-pane/stale-document-visibility'

type FakeElement = { style: { transform: string } }

function makeElement(): HTMLElement {
  return { style: { transform: '' } } as unknown as HTMLElement
}

function stubDom(visibilityState: () => DocumentVisibilityState): {
  fireVisibilityChange: () => void
} {
  const documentListeners = new Map<string, Set<(event?: unknown) => void>>()
  const addListener = (event: string, listener: (event?: unknown) => void): void => {
    if (!documentListeners.has(event)) {
      documentListeners.set(event, new Set())
    }
    documentListeners.get(event)!.add(listener)
  }
  vi.stubGlobal('document', {
    get visibilityState() {
      return visibilityState()
    },
    addEventListener: vi.fn(addListener),
    removeEventListener: vi.fn((event: string, listener: (event?: unknown) => void) => {
      documentListeners.get(event)?.delete(listener)
    })
  })
  vi.stubGlobal('window', {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    matchMedia: vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }))
  })
  return {
    fireVisibilityChange: () => {
      for (const listener of documentListeners.get('visibilitychange') ?? []) {
        listener()
      }
    }
  }
}

describe('agent-spinner-clock', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    resetAgentSpinnerClockForTesting()
    resetStaleDocumentVisibilityForTesting()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('rotates every registered element in phase from one shared timer', () => {
    stubDom(() => 'visible')
    const a = makeElement()
    const unregisterA = registerAgentSpinnerElement(a)

    // Registration seeds the current dial position immediately.
    expect((a as unknown as FakeElement).style.transform).toMatch(/^rotate\(\d+deg\)$/)

    vi.advanceTimersByTime(AGENT_SPINNER_TICK_MS * 3)
    const b = makeElement()
    const unregisterB = registerAgentSpinnerElement(b)

    // A late joiner starts at the shared dial position, not at zero.
    expect((b as unknown as FakeElement).style.transform).toBe(
      (a as unknown as FakeElement).style.transform
    )

    const before = (a as unknown as FakeElement).style.transform
    vi.advanceTimersByTime(AGENT_SPINNER_TICK_MS)
    expect((a as unknown as FakeElement).style.transform).not.toBe(before)
    expect((b as unknown as FakeElement).style.transform).toBe(
      (a as unknown as FakeElement).style.transform
    )

    unregisterA()
    unregisterB()
  })

  it('stops ticking while the document is hidden and resumes on visibility', () => {
    let visibility: DocumentVisibilityState = 'visible'
    const { fireVisibilityChange } = stubDom(() => visibility)
    const el = makeElement()
    const unregister = registerAgentSpinnerElement(el)

    visibility = 'hidden'
    fireVisibilityChange()
    const frozen = (el as unknown as FakeElement).style.transform
    vi.advanceTimersByTime(AGENT_SPINNER_TICK_MS * 10)
    expect((el as unknown as FakeElement).style.transform).toBe(frozen)

    visibility = 'visible'
    fireVisibilityChange()
    // Resume advances immediately so the restored window visibly spins again.
    expect((el as unknown as FakeElement).style.transform).not.toBe(frozen)

    unregister()
  })

  it('clears its timer when the last element unregisters', () => {
    stubDom(() => 'visible')
    const el = makeElement()
    const unregister = registerAgentSpinnerElement(el)
    unregister()

    const parked = (el as unknown as FakeElement).style.transform
    vi.advanceTimersByTime(AGENT_SPINNER_TICK_MS * 5)
    expect((el as unknown as FakeElement).style.transform).toBe(parked)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not tick when prefers-reduced-motion is set', () => {
    stubDom(() => 'visible')
    const windowStub = globalThis.window as unknown as { matchMedia: ReturnType<typeof vi.fn> }
    windowStub.matchMedia = vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }))

    const el = makeElement()
    const unregister = registerAgentSpinnerElement(el)
    const initial = (el as unknown as FakeElement).style.transform
    vi.advanceTimersByTime(AGENT_SPINNER_TICK_MS * 5)
    expect((el as unknown as FakeElement).style.transform).toBe(initial)

    unregister()
  })
})
