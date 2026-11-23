// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { expect, it, vi } from 'vitest'
import { useNativeChatPacedText } from './use-native-chat-paced-text'
import {
  NativeChatHeldTextSessionContext,
  NativeChatReplyRevealsContext,
  NativeChatSaveFallbackContext
} from './native-chat-reply-reveals'
import { createNativeChatReplyRevealTracker } from '../../../../../shared/native-chat/transcript/row-content/native-chat-reply-reveals'
import type { NativeChatTextReveal } from '../../../../../shared/native-chat/transcript/row-content/native-chat-text-reveal'
import { documentViewerVisibility } from '../session/structured/read/document-viewer-visibility'

function renderReply(chat: string) {
  const root = { current: null }
  const wrapper = ({ children }: { children: ReactNode }) => (
    <NativeChatHeldTextSessionContext.Provider value={chat}>
      {children}
    </NativeChatHeldTextSessionContext.Provider>
  )
  return renderHook(({ text }) => useNativeChatPacedText('reply', text, true, root), {
    initialProps: { text: 'The reply so far.' },
    wrapper
  })
}

const held = `The reply so far. ${'and much more text that arrived while the window was minimized '.repeat(40)}`

it('draws text its chat held while the window was hidden at once, without fading it in', () => {
  const { result, rerender } = renderReply('chat-a')
  act(() => {
    documentViewerVisibility('chat-a').heldDrawn?.()
  })
  rerender({ text: held })
  expect(result.current.text).toBe(held)
  expect(result.current.fadeFrom ?? held.length).toBe(held.length)
})

it('keeps revealing a reply whose chat held nothing, while another chat catches up', () => {
  const { result, rerender } = renderReply('chat-c')
  act(() => {
    documentViewerVisibility('chat-d').heldDrawn?.()
  })
  rerender({ text: held })
  expect(result.current.text.length).toBeLessThan(held.length)
})

it('shows a reply redrawn whole only at its saves, revealed as main reveals them', () => {
  vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })
  try {
    const { reveals } = createNativeChatReplyRevealTracker()
    reveals.drawn.set('reply', {
      source: 'one',
      shown: 3,
      arrivals: [],
      drawsWhole: true,
      savedAt: 1
    })
    const root = { current: null }
    const { result, rerender } = renderHook(
      ({ text, revision }) => useNativeChatPacedText('reply', text, true, root, revision),
      {
        initialProps: { text: 'one', revision: 1 },
        wrapper: ({ children }: { children: ReactNode }) => (
          <NativeChatReplyRevealsContext.Provider value={reveals}>
            <NativeChatSaveFallbackContext.Provider value>
              {children}
            </NativeChatSaveFallbackContext.Provider>
          </NativeChatReplyRevealsContext.Provider>
        )
      }
    )
    // Live text at the same revision waits for its save.
    rerender({ text: 'one two three', revision: 1 })
    act(() => vi.advanceTimersByTime(1000))
    expect(result.current.text).toBe('one')
    // A save is revealed over main's 350 ms, then shown whole.
    rerender({ text: 'one two three four', revision: 2 })
    act(() => vi.advanceTimersByTime(200))
    expect(result.current.text.length).toBeGreaterThan(3)
    expect(result.current.text.length).toBeLessThan(18)
    act(() => vi.advanceTimersByTime(300))
    expect(result.current.text).toBe('one two three four')
    expect(result.current.fadeFrom).toBeUndefined()
  } finally {
    vi.useRealTimers()
  }
})

function renderRemembered(
  remembered: NativeChatTextReveal,
  initialProps: { text: string; revision: number | undefined },
  savesAsRepliesGrow = true
) {
  const { reveals } = createNativeChatReplyRevealTracker()
  reveals.drawn.set('reply', remembered)
  const root = { current: null }
  return renderHook(
    ({ text, revision }) => useNativeChatPacedText('reply', text, true, root, revision),
    {
      initialProps,
      wrapper: ({ children }: { children: ReactNode }) => (
        <NativeChatReplyRevealsContext.Provider value={reveals}>
          <NativeChatSaveFallbackContext.Provider value={savesAsRepliesGrow}>
            {children}
          </NativeChatSaveFallbackContext.Provider>
        </NativeChatReplyRevealsContext.Provider>
      )
    }
  )
}

it('finishes revealing a save after a remount part way through it', () => {
  vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })
  try {
    const save = 'one two three four'
    const { result } = renderRemembered(
      {
        source: save,
        shown: 3,
        arrivals: [{ from: 3, to: save.length, at: performance.now() }],
        drawsWhole: true,
        savedAt: 2
      },
      { text: `${save} five six`, revision: 2 }
    )
    act(() => vi.advanceTimersByTime(600))
    expect(result.current.text).toBe(save)
  } finally {
    vi.useRealTimers()
  }
})

it('keeps following a row with no saves to wait for, though it was redrawn whole', () => {
  vi.useFakeTimers({
    toFake: [
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'performance',
      'setTimeout',
      'clearTimeout'
    ]
  })
  try {
    const { result, rerender } = renderRemembered(
      { source: 'one', shown: 3, arrivals: [], drawsWhole: true },
      { text: 'one', revision: undefined }
    )
    rerender({ text: 'one two three', revision: undefined })
    act(() => vi.advanceTimersByTime(2000))
    expect(result.current.text).toBe('one two three')

    // A provider that saves only at block ends: its revisions are no saves to wait for.
    const blockEnds = renderRemembered(
      { source: 'one', shown: 3, arrivals: [], drawsWhole: true, savedAt: 2 },
      { text: 'one', revision: 2 },
      false
    )
    blockEnds.rerender({ text: 'one two three', revision: 2 })
    act(() => vi.advanceTimersByTime(2000))
    expect(blockEnds.result.current.text).toBe('one two three')
  } finally {
    vi.useRealTimers()
  }
})

it('takes a save made while it was unmounted when it mounts again', () => {
  vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })
  try {
    const { result } = renderRemembered(
      { source: 'one', shown: 3, arrivals: [], drawsWhole: true, savedAt: 2 },
      { text: 'one two three', revision: 3 }
    )
    act(() => vi.advanceTimersByTime(600))
    expect(result.current.text).toBe('one two three')
  } finally {
    vi.useRealTimers()
  }
})

it('keeps a reply that shows only its saves on its last save through a catch-up', () => {
  vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })
  try {
    const { reveals } = createNativeChatReplyRevealTracker()
    reveals.drawn.set('reply', {
      source: 'one',
      shown: 3,
      arrivals: [],
      drawsWhole: true,
      savedAt: 2
    })
    const root = { current: null }
    const { result, rerender } = renderHook(
      ({ text, revision }) => useNativeChatPacedText('reply', text, true, root, revision),
      {
        initialProps: { text: 'one', revision: 2 },
        wrapper: ({ children }: { children: ReactNode }) => (
          <NativeChatReplyRevealsContext.Provider value={reveals}>
            <NativeChatHeldTextSessionContext.Provider value="chat-saves">
              <NativeChatSaveFallbackContext.Provider value>
                {children}
              </NativeChatSaveFallbackContext.Provider>
            </NativeChatHeldTextSessionContext.Provider>
          </NativeChatReplyRevealsContext.Provider>
        )
      }
    )
    // Shown again with live text that came while hidden, but no new save.
    act(() => {
      documentViewerVisibility('chat-saves').heldDrawn?.()
    })
    rerender({ text: 'one two', revision: 2 })
    act(() => vi.advanceTimersByTime(600))
    expect(result.current.text).toBe('one')
    // A save that arrives with a catch-up is revealed, not drawn at once.
    act(() => {
      documentViewerVisibility('chat-saves').heldDrawn?.()
    })
    rerender({ text: 'one two three four five six seven', revision: 3 })
    expect(result.current.text.length).toBeLessThan('one two three four five six seven'.length)
    act(() => vi.advanceTimersByTime(600))
    expect(result.current.text).toBe('one two three four five six seven')
  } finally {
    vi.useRealTimers()
  }
})

// Perf contract: a reply that fell back to its saves reveals a slow final save in the same frames
// main does (part of it, then the rest once that slow step is done), not in one step.
it("paints a slow final save in main's frames after falling back to its saves", () => {
  vi.useFakeTimers({
    toFake: [
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'performance',
      'setTimeout',
      'clearTimeout'
    ]
  })
  const clock = performance.now.bind(performance)
  let busyMs = 0
  vi.spyOn(performance, 'now').mockImplementation(() => clock() + busyMs)
  try {
    const before = 'word '.repeat(2000)
    const save = `${before}${'more '.repeat(4000)}`
    // Each step renders for 3 s; `busy` ms of other work (a turn's end) runs before the first frame.
    const framesOf = (fallback: boolean, busy: number): number[] => {
      const { result, rerender } = renderRemembered(
        fallback
          ? { source: before, shown: before.length, arrivals: [], drawsWhole: true, savedAt: 45 }
          : { source: before, shown: before.length, arrivals: [] },
        { text: before, revision: 45 },
        fallback
      )
      rerender({ text: save, revision: 47 })
      busyMs += busy
      const drawn: number[] = []
      for (let step = 0; step < 4; step++) {
        act(() => vi.advanceTimersByTime(17))
        drawn.push(result.current.text.length)
        act(() => vi.advanceTimersByTime(3000))
      }
      return [...new Set(drawn)].filter((length) => length > before.length + 10)
    }
    for (const frames of [framesOf(false, 0), framesOf(true, 0), framesOf(true, 1000)]) {
      expect(frames).toHaveLength(2)
      expect(frames[0]).toBeLessThan(save.length)
      expect(frames[1]).toBe(save.length)
    }
  } finally {
    vi.restoreAllMocks()
    vi.useRealTimers()
  }
})
