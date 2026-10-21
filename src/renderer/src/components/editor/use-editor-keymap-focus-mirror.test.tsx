// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useEditorKeymapFocusMirror } from './use-editor-keymap-focus-mirror'

describe('useEditorKeymapFocusMirror', () => {
  const setEditorKeymapFocused = vi.fn()
  let container: HTMLDivElement
  let inner: HTMLTextAreaElement
  let outside: HTMLButtonElement

  beforeEach(() => {
    setEditorKeymapFocused.mockClear()
    vi.stubGlobal('api', { ui: { setEditorKeymapFocused } })
    Object.assign(window, { api: { ui: { setEditorKeymapFocused } } })
    container = document.createElement('div')
    inner = document.createElement('textarea')
    outside = document.createElement('button')
    container.append(inner)
    document.body.append(container, outside)
  })

  afterEach(() => {
    document.body.replaceChildren()
    vi.unstubAllGlobals()
  })

  it('reports focus entering and leaving the editor container, and clears on disable', () => {
    const ref = { current: container }
    const { rerender, unmount } = renderHook(
      ({ enabled }: { enabled: boolean }) => useEditorKeymapFocusMirror(ref, enabled),
      { initialProps: { enabled: true } }
    )
    expect(setEditorKeymapFocused).not.toHaveBeenCalled()

    act(() => inner.focus())
    expect(setEditorKeymapFocused).toHaveBeenLastCalledWith(true)

    // Focus moving within the container (editor → find widget) is not a loss.
    const findInput = document.createElement('input')
    container.append(findInput)
    setEditorKeymapFocused.mockClear()
    act(() => findInput.focus())
    expect(setEditorKeymapFocused.mock.calls).not.toContainEqual([false])

    act(() => outside.focus())
    expect(setEditorKeymapFocused).toHaveBeenLastCalledWith(false)

    setEditorKeymapFocused.mockClear()
    act(() => inner.focus())
    rerender({ enabled: false })
    expect(setEditorKeymapFocused).toHaveBeenLastCalledWith(false)

    setEditorKeymapFocused.mockClear()
    act(() => outside.focus())
    expect(setEditorKeymapFocused).not.toHaveBeenCalled()
    unmount()
  })

  it('reports immediately when the preset turns on while the editor already has focus', () => {
    inner.focus()
    const ref = { current: container }
    const { unmount } = renderHook(() => useEditorKeymapFocusMirror(ref, true))
    expect(setEditorKeymapFocused).toHaveBeenLastCalledWith(true)
    unmount()
    expect(setEditorKeymapFocused).toHaveBeenLastCalledWith(false)
  })
})
