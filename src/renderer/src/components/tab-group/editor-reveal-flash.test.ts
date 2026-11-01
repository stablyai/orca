// @vitest-environment happy-dom

import { act, render, renderHook } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditorRevealFlash } from './EditorRevealFlash'
import {
  EDITOR_REVEAL_FLASH_MS,
  flashRevealedEditorView,
  useEditorRevealFlashKey
} from './editor-reveal-flash'

describe('editor reveal flash', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('flashes only the revealed view and clears after the animation', () => {
    vi.useFakeTimers()
    const target = renderHook(() => useEditorRevealFlashKey('view-a'))
    const other = renderHook(() => useEditorRevealFlashKey('view-b'))

    act(() => flashRevealedEditorView('view-a'))
    expect(target.result.current).not.toBeNull()
    expect(other.result.current).toBeNull()

    act(() => vi.advanceTimersByTime(EDITOR_REVEAL_FLASH_MS))
    expect(target.result.current).toBeNull()
  })

  it('replaces the overlay and resets its lifetime on a repeat flash', () => {
    vi.useFakeTimers()
    const { container } = render(createElement(EditorRevealFlash, { viewStateId: 'view-c' }))

    act(() => flashRevealedEditorView('view-c'))
    const firstOverlay = container.querySelector('.editor-reveal-flash')
    expect(firstOverlay).not.toBeNull()
    act(() => vi.advanceTimersByTime(EDITOR_REVEAL_FLASH_MS - 100))
    act(() => flashRevealedEditorView('view-c'))
    const secondOverlay = container.querySelector('.editor-reveal-flash')
    expect(secondOverlay).not.toBeNull()
    expect(secondOverlay).not.toBe(firstOverlay)
    expect(firstOverlay?.isConnected).toBe(false)

    act(() => vi.advanceTimersByTime(EDITOR_REVEAL_FLASH_MS - 100))
    expect(container.querySelector('.editor-reveal-flash')).toBe(secondOverlay)
    act(() => vi.advanceTimersByTime(100))
    expect(container.querySelector('.editor-reveal-flash')).toBeNull()
  })
})
