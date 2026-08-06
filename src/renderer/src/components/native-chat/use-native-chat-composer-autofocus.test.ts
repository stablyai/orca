// @vitest-environment happy-dom
import { createRef } from 'react'
import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useNativeChatComposerAutofocus } from './use-native-chat-composer-autofocus'
import type { NativeChatComposerHandle } from './NativeChatComposer'

function installAnimationFrameStubs(): { flushOneFrame: () => void } {
  const pending: FrameRequestCallback[] = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {
    pending.push(callback)
    return pending.length
  })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  return {
    flushOneFrame: () => {
      const callback = pending.shift()
      callback?.(0)
    }
  }
}

function renderAutofocus(args: {
  chatSurfaceActive: boolean
  composerEnabled: boolean
  root: HTMLElement
}): { composerRef: React.RefObject<NativeChatComposerHandle | null> } {
  const rootRef = createRef<HTMLElement>()
  rootRef.current = args.root
  const composerRef = createRef<NativeChatComposerHandle>()
  const composerHandle: NativeChatComposerHandle = {
    focus: vi.fn(() => true),
    insertTypedText: vi.fn(() => true),
    handlePasteEvent: vi.fn(),
    pasteFromClipboard: vi.fn()
  }
  composerRef.current = composerHandle
  renderHook(() =>
    useNativeChatComposerAutofocus({
      chatSurfaceActive: args.chatSurfaceActive,
      composerEnabled: args.composerEnabled,
      questionActive: false,
      rootRef,
      composerRef
    })
  )
  return { composerRef }
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
})
