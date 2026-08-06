// @vitest-environment happy-dom
import { createRef } from 'react'
import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useNativeChatComposerAutofocus } from './use-native-chat-composer-autofocus'
import type { NativeChatComposerHandle } from './NativeChatComposer'

function installAnimationFrameStubs(): { flushOneFrame: () => void; flushAll: () => void } {
  const pending: FrameRequestCallback[] = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {
    pending.push(callback)
    return pending.length
  })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  return {
    flushOneFrame: () => {
      pending.shift()?.(0)
    },
    flushAll: () => {
      for (let i = 0; i < 10 && pending.length > 0; i += 1) {
        pending.shift()?.(0)
      }
    }
  }
}

type HookProps = { chatSurfaceActive: boolean; composerEnabled: boolean; questionActive: boolean }

function renderAutofocus(initial: Partial<HookProps> & { root: HTMLElement }): {
  composerRef: React.RefObject<NativeChatComposerHandle | null>
  rerender: (next: Partial<HookProps>) => void
} {
  const rootRef = createRef<HTMLElement>()
  rootRef.current = initial.root
  const composerRef = createRef<NativeChatComposerHandle>()
  composerRef.current = {
    focus: vi.fn(() => true),
    insertTypedText: vi.fn(() => true),
    handlePasteEvent: vi.fn(),
    pasteFromClipboard: vi.fn()
  }
  const props: HookProps = {
    chatSurfaceActive: initial.chatSurfaceActive ?? false,
    composerEnabled: initial.composerEnabled ?? true,
    questionActive: initial.questionActive ?? false
  }
  const rendered = renderHook(
    (current: HookProps) =>
      useNativeChatComposerAutofocus({
        chatSurfaceActive: current.chatSurfaceActive,
        composerEnabled: current.composerEnabled,
        questionActive: current.questionActive,
        rootRef,
        composerRef
      }),
    { initialProps: props }
  )
  return {
    composerRef,
    rerender: (next) => rendered.rerender({ ...props, ...Object.assign(props, next) })
  }
}

describe('useNativeChatComposerAutofocus', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
  })

  it('schedules no frames when the chat surface is not active', () => {
    const requestAnimationFrame = vi.fn()
    vi.stubGlobal('requestAnimationFrame', requestAnimationFrame)
    const root = document.createElement('div')
    document.body.append(root)

    renderAutofocus({ chatSurfaceActive: false, composerEnabled: true, root })

    expect(requestAnimationFrame).not.toHaveBeenCalled()
  })

  it('focuses the composer once both frames flush and focus is neutral', () => {
    const { flushOneFrame } = installAnimationFrameStubs()
    const root = document.createElement('div')
    document.body.append(root)

    const { composerRef } = renderAutofocus({
      chatSurfaceActive: true,
      composerEnabled: true,
      root
    })

    expect(composerRef.current?.focus).not.toHaveBeenCalled()
    flushOneFrame()
    expect(composerRef.current?.focus).not.toHaveBeenCalled()
    flushOneFrame()
    expect(composerRef.current?.focus).toHaveBeenCalled()
  })

  it('reads activeElement only after both frames — regression for the tab-switch race where a sibling chat tab’s own real composer is still focused at effect-run time and only blurs (to body) between frames', () => {
    const { flushOneFrame } = installAnimationFrameStubs()
    const root = document.createElement('div')
    document.body.append(root)
    const stalePreviousComposer = document.createElement('textarea')
    document.body.append(stalePreviousComposer)
    stalePreviousComposer.focus()
    expect(document.activeElement).toBe(stalePreviousComposer)

    const { composerRef } = renderAutofocus({
      chatSurfaceActive: true,
      composerEnabled: true,
      root
    })

    flushOneFrame()
    // Why: the browser's real display:none-triggered blur is what this
    // simulates — it can land in the gap between the two scheduled frames.
    stalePreviousComposer.blur()
    expect(document.activeElement).toBe(document.body)
    flushOneFrame()

    expect(composerRef.current?.focus).toHaveBeenCalled()
  })

  it('does not steal focus from a real input that is still genuinely focused after both frames', () => {
    const { flushOneFrame } = installAnimationFrameStubs()
    const root = document.createElement('div')
    document.body.append(root)
    const unrelatedInput = document.createElement('input')
    document.body.append(unrelatedInput)
    unrelatedInput.focus()

    const { composerRef } = renderAutofocus({
      chatSurfaceActive: true,
      composerEnabled: true,
      root
    })

    flushOneFrame()
    flushOneFrame()

    expect(composerRef.current?.focus).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(unrelatedInput)
  })

  it('waits for the composer to enable, then focuses once (new-session flow)', () => {
    const { flushAll } = installAnimationFrameStubs()
    const root = document.createElement('div')
    document.body.append(root)

    const { composerRef, rerender } = renderAutofocus({
      chatSurfaceActive: true,
      composerEnabled: false,
      root
    })

    flushAll()
    expect(composerRef.current?.focus).not.toHaveBeenCalled()

    rerender({ composerEnabled: true })
    flushAll()
    expect(composerRef.current?.focus).toHaveBeenCalledTimes(1)
  })

  it('does not re-steal focus on a later enable flip once the activation intent is consumed', () => {
    // Why: composerEnabled tracks the async mobile presence-lock; a release
    // minutes after activation must not yank focus (codex review finding).
    const { flushAll } = installAnimationFrameStubs()
    const root = document.createElement('div')
    document.body.append(root)

    const { composerRef, rerender } = renderAutofocus({
      chatSurfaceActive: true,
      composerEnabled: true,
      root
    })

    flushAll()
    expect(composerRef.current?.focus).toHaveBeenCalledTimes(1)

    rerender({ composerEnabled: false })
    rerender({ composerEnabled: true })
    flushAll()

    expect(composerRef.current?.focus).toHaveBeenCalledTimes(1)
  })

  it('re-arms the intent on the next activation', () => {
    const { flushAll } = installAnimationFrameStubs()
    const root = document.createElement('div')
    document.body.append(root)

    const { composerRef, rerender } = renderAutofocus({
      chatSurfaceActive: true,
      composerEnabled: true,
      root
    })

    flushAll()
    rerender({ chatSurfaceActive: false })
    rerender({ chatSurfaceActive: true })
    flushAll()

    expect(composerRef.current?.focus).toHaveBeenCalledTimes(2)
  })
})
