// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { useClaudeSubmitGestureMatch, useComposerSubmitKeyMatch } from './use-claude-submit-gesture'
import { resetClaudeSubmitBytesCacheForTests } from './native-chat-claude-submit-cache'

const readClaudeKeybindings = vi.fn()

const chat = (bindings: Record<string, string>): string =>
  JSON.stringify({ bindings: [{ context: 'Chat', bindings }] })

const enterEvent = { key: 'Enter', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false }
const altEnterEvent = { ...enterEvent, altKey: true }

describe('useClaudeSubmitGestureMatch', () => {
  beforeEach(() => {
    readClaudeKeybindings.mockReset()
    resetClaudeSubmitBytesCacheForTests()
    // Set the property rather than replacing window, so happy-dom's document
    // (which @testing-library's waitFor needs) stays intact.
    ;(window as unknown as { api: unknown }).api = { nativeChat: { readClaudeKeybindings } }
  })
  afterEach(() => {
    cleanup()
    delete (window as unknown as { api?: unknown }).api
    resetClaudeSubmitBytesCacheForTests()
  })

  it('primes the keybindings read on mount', () => {
    readClaudeKeybindings.mockReturnValue(new Promise(() => {}))
    renderHook(() => useClaudeSubmitGestureMatch())
    expect(readClaudeKeybindings).toHaveBeenCalledOnce()
  })

  it('turns Enter into a newline once the remap loads, and submits on Alt+Enter', async () => {
    readClaudeKeybindings.mockResolvedValue(
      chat({ enter: 'chat:newline', 'alt+enter': 'chat:submit' })
    )
    const { result } = renderHook(() => useClaudeSubmitGestureMatch())
    // Enter stops submitting only after the remapped config resolves.
    await waitFor(() => expect(result.current(enterEvent)).toBe(false))
    expect(result.current(altEnterEvent)).toBe(true)
  })
})

describe('useComposerSubmitKeyMatch', () => {
  const remap = (): string => chat({ enter: 'chat:newline', 'alt+enter': 'chat:submit' })
  beforeEach(() => {
    readClaudeKeybindings.mockReset()
    resetClaudeSubmitBytesCacheForTests()
    ;(window as unknown as { api: unknown }).api = { nativeChat: { readClaudeKeybindings } }
  })
  afterEach(() => {
    cleanup()
    delete (window as unknown as { api?: unknown }).api
    resetClaudeSubmitBytesCacheForTests()
  })

  it('mirrors a remapped gesture for a local Claude pane', async () => {
    readClaudeKeybindings.mockResolvedValue(remap())
    const { result } = renderHook(() => useComposerSubmitKeyMatch('claude', false))
    await waitFor(() => expect(result.current(enterEvent)).toBe(false))
    expect(result.current(altEnterEvent)).toBe(true)
  })

  it('keeps the default Enter for a non-Claude pane even with a remap available', () => {
    readClaudeKeybindings.mockResolvedValue(remap())
    const { result } = renderHook(() => useComposerSubmitKeyMatch('codex', false))
    expect(result.current(enterEvent)).toBe(true)
    expect(result.current({ ...enterEvent, shiftKey: true })).toBe(false)
    expect(readClaudeKeybindings).not.toHaveBeenCalled()
  })

  it('keeps the default Enter for a remote Claude pane', async () => {
    readClaudeKeybindings.mockResolvedValue(remap())
    const { result } = renderHook(() => useComposerSubmitKeyMatch('claude', true))
    await waitFor(() => expect(readClaudeKeybindings).toHaveBeenCalled())
    expect(result.current(enterEvent)).toBe(true)
    expect(result.current({ ...enterEvent, shiftKey: true })).toBe(false)
  })
})
