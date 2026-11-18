// @vitest-environment happy-dom

import { act, cleanup, render, renderHook } from '@testing-library/react'
import { Component, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useBotPanelFold, useBotPanelFolded } from './use-bot-panel-fold'

const FOLDS_KEY = 'orca.bots.panelFolds'

const realStorage = window.localStorage

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  Object.defineProperty(window, 'localStorage', { value: realStorage, configurable: true })
  window.localStorage.clear()
})

/** Storage keeps what it held and refuses every write, as when it is full; returns what it holds. */
function refuseWrites(): Map<string, string> {
  const held = new Map(Object.entries({ ...realStorage }))
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => held.get(key) ?? null,
      setItem: () => {
        throw new DOMException('full', 'QuotaExceededError')
      }
    }
  })
  return held
}

/** Another window of this Orca saves `folds`; its storage event comes when the returned call says. */
function otherWindowSaves(
  folds: Record<string, string[]>,
  storage: { set: (key: string, value: string) => void } = {
    set: (key, value) => realStorage.setItem(key, value)
  }
): () => void {
  const newValue = JSON.stringify(folds)
  storage.set(FOLDS_KEY, newValue)
  return () =>
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: FOLDS_KEY, newValue }))
    })
}

const stored = (): unknown => JSON.parse(realStorage.getItem(FOLDS_KEY) ?? 'null')

function twoBots() {
  return renderHook(() => ({
    mine: useBotPanelFold('mine', 'suggestions'),
    theirs: useBotPanelFolded('theirs', 'suggestions')
  }))
}

describe('useBotPanelFold', () => {
  it('reopens a folded card, and folds it again, once storage refuses writes', () => {
    const { result } = renderHook(() => ({
      fold: useBotPanelFold('refused-1', 'suggestions'),
      sidebar: useBotPanelFolded('refused-1', 'suggestions')
    }))
    act(() => result.current.fold.onOpenChange(false))
    expect(result.current.fold.open).toBe(false)

    refuseWrites()
    act(() => result.current.fold.onOpenChange(true))
    expect(result.current.fold.open).toBe(true)
    expect(result.current.sidebar).toBe(false)

    act(() => result.current.fold.onOpenChange(false))
    expect(result.current.fold.open).toBe(false)
    expect(result.current.sidebar).toBe(true)
  })

  it("keeps a fold storage refused after the bot's rows unmount", () => {
    refuseWrites()
    const first = renderHook(() => useBotPanelFold('refused-2', 'suggestions'))
    act(() => first.result.current.onOpenChange(false))
    first.unmount()

    expect(renderHook(() => useBotPanelFold('refused-2', 'suggestions')).result.current.open).toBe(
      false
    )
  })

  it('follows a fold made in another window', () => {
    const { result } = renderHook(() => useBotPanelFolded('bot-1', 'suggestions'))
    expect(result.current).toBe(false)

    otherWindowSaves({ 'bot-1': ['suggestions'] })()
    expect(result.current).toBe(true)

    otherWindowSaves({})()
    expect(result.current).toBe(false)
  })

  it("keeps another window's fold when folding here before its event arrives, and its late event undoes nothing", () => {
    const { result } = twoBots()
    const lateEvent = otherWindowSaves({ theirs: ['suggestions'] })

    act(() => result.current.mine.onOpenChange(false))
    expect(stored()).toMatchObject({ theirs: ['suggestions'], mine: ['suggestions'] })

    lateEvent()
    expect(result.current.mine.open).toBe(false)
    expect(result.current.theirs).toBe(true)
  })

  it("keeps another window's fold when folding here after its event arrives", () => {
    const { result } = twoBots()
    otherWindowSaves({ theirs: ['suggestions'] })()
    expect(result.current.theirs).toBe(true)

    act(() => result.current.mine.onOpenChange(false))
    expect(stored()).toMatchObject({ theirs: ['suggestions'], mine: ['suggestions'] })
    expect(result.current.mine.open).toBe(false)
    expect(result.current.theirs).toBe(true)
  })

  it("keeps a fold storage refused when another window's event arrives", () => {
    const { result } = twoBots()
    const held = refuseWrites()
    act(() => result.current.mine.onOpenChange(false))

    otherWindowSaves({ theirs: ['suggestions'] }, { set: (key, value) => held.set(key, value) })()
    expect(result.current.mine.open).toBe(false)
    expect(result.current.theirs).toBe(true)

    // Saved by the next write that storage takes.
    Object.defineProperty(window, 'localStorage', { value: realStorage, configurable: true })
    realStorage.setItem(FOLDS_KEY, held.get(FOLDS_KEY)!)
    act(() => result.current.mine.onOpenChange(true))
    act(() => result.current.mine.onOpenChange(false))
    expect(stored()).toMatchObject({ theirs: ['suggestions'], mine: ['suggestions'] })
  })

  // Orca before the Chats tab also folded a Chats card; its id stays saved beside Suggestions.
  const LEGACY_CARD = 'chats'

  it("keeps another card's fold another window saved on the same bot when Suggestions folds here before its event", () => {
    const { result } = renderHook(() => useBotPanelFold('cards-1', 'suggestions'))
    const lateEvent = otherWindowSaves({ 'cards-1': [LEGACY_CARD] })

    act(() => result.current.onOpenChange(false))
    expect(stored()).toMatchObject({ 'cards-1': [LEGACY_CARD, 'suggestions'] })

    lateEvent()
    expect(result.current.open).toBe(false)
    expect(stored()).toMatchObject({ 'cards-1': [LEGACY_CARD, 'suggestions'] })
  })

  it("keeps another card's later change on a bot whose Suggestions fold storage refused", () => {
    const { result } = renderHook(() => ({
      fold: useBotPanelFold('cards-2', 'suggestions'),
      other: useBotPanelFold('cards-2b', 'suggestions')
    }))
    const held = refuseWrites()
    act(() => result.current.fold.onOpenChange(false))

    otherWindowSaves({ 'cards-2': [LEGACY_CARD] }, { set: (key, value) => held.set(key, value) })()
    expect(result.current.fold.open).toBe(false)

    // Storage takes writes again; the next one saves the refused fold over the other window's.
    Object.defineProperty(window, 'localStorage', { value: realStorage, configurable: true })
    realStorage.setItem(FOLDS_KEY, held.get(FOLDS_KEY)!)
    act(() => result.current.other.onOpenChange(false))
    expect(stored()).toMatchObject({ 'cards-2': [LEGACY_CARD, 'suggestions'] })
  })

  it("shows a fold another window saved between a row's first read and its subscription", () => {
    let saved = false
    const { result } = renderHook(() => {
      const folded = useBotPanelFolded('gap-1', 'suggestions')
      if (!saved) {
        // Rendered, not yet subscribed: nothing listens for this event.
        saved = true
        const newValue = JSON.stringify({ 'gap-1': ['suggestions'] })
        realStorage.setItem(FOLDS_KEY, newValue)
        window.dispatchEvent(new StorageEvent('storage', { key: FOLDS_KEY, newValue }))
      }
      return folded
    })
    expect(result.current).toBe(true)
  })

  it('reads storage again when a row mounts after a render that never committed', () => {
    class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
      state = { failed: false }
      static getDerivedStateFromError(): { failed: boolean } {
        return { failed: true }
      }
      render(): ReactNode {
        return this.state.failed ? null : this.props.children
      }
    }
    function Abandoned(): null {
      useBotPanelFolded('gap-2', 'suggestions')
      throw new Error('abandoned')
    }
    vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <Boundary>
        <Abandoned />
      </Boundary>
    )
    cleanup()
    // Saved by another window while nothing listened.
    realStorage.setItem(FOLDS_KEY, JSON.stringify({ 'gap-2': ['suggestions'] }))

    expect(renderHook(() => useBotPanelFolded('gap-2', 'suggestions')).result.current).toBe(true)
  })

  it("ignores other keys' storage events", () => {
    const { result } = renderHook(() => useBotPanelFolded('bot-1', 'suggestions'))
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', { key: 'other', newValue: '{"bot-1":["suggestions"]}' })
      )
    })
    expect(result.current).toBe(false)
  })
})
