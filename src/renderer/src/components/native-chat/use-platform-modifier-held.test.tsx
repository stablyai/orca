// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { usePlatformModifierHeld } from './use-platform-modifier-held'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const WATCHED = new Set(['keydown', 'keyup', 'paste', 'blur'])

function mountConsumers(count: number, isMac = true) {
  const renders = Array.from({ length: count }, () => 0)
  const held = Array.from({ length: count }, () => false)
  function Consumer({ index }: { index: number }) {
    renders[index] += 1
    held[index] = usePlatformModifierHeld(true, isMac)
    return null
  }
  render(
    <>
      {renders.map((_, index) => (
        <Consumer key={index} index={index} />
      ))}
    </>
  )
  return { renders, held }
}

describe('usePlatformModifierHeld', () => {
  it.each([5, 50])(
    'shares one listener set across %i chats and renders only on a real modifier change',
    (count) => {
      const add = vi.spyOn(window, 'addEventListener')
      const remove = vi.spyOn(window, 'removeEventListener')
      const attached = (): number =>
        add.mock.calls.filter(([type]) => WATCHED.has(type)).length -
        remove.mock.calls.filter(([type]) => WATCHED.has(type)).length
      const { renders, held } = mountConsumers(count)
      expect(attached()).toBe(4)

      const settled = [...renders]
      act(() => {
        fireEvent.keyDown(window, { key: 'a' })
      })
      act(() => {
        fireEvent.keyUp(window, { key: 'a' })
      })
      act(() => {
        fireEvent.keyDown(window, { key: 'Shift', shiftKey: true })
      })
      expect(renders).toEqual(settled)

      act(() => {
        fireEvent.keyDown(window, { key: 'Meta', metaKey: true })
      })
      expect(renders).toEqual(settled.map((n) => n + 1))
      expect(held.every(Boolean)).toBe(true)
      act(() => {
        fireEvent.keyDown(window, { key: 'k', metaKey: true })
      })
      expect(renders).toEqual(settled.map((n) => n + 1))

      cleanup()
      expect(attached()).toBe(0)
    }
  )

  it('counts the modifier as held only from its own keydown', () => {
    const { held } = mountConsumers(1)
    // A dictation paste can leave metaKey set on later key events with Cmd up.
    fireEvent.paste(window)
    fireEvent.keyDown(window, { key: 'a', metaKey: true })
    expect(held[0]).toBe(false)

    fireEvent.keyDown(window, { key: 'Meta', metaKey: true })
    expect(held[0]).toBe(true)
    // A keyup another handler swallowed still clears on the next key.
    fireEvent.keyDown(window, { key: 'a', metaKey: false })
    expect(held[0]).toBe(false)

    fireEvent.keyDown(window, { key: 'Meta', metaKey: true })
    fireEvent.blur(window)
    expect(held[0]).toBe(false)
  })

  it('reads Ctrl, not Cmd, off the Mac', () => {
    const { held } = mountConsumers(1, false)
    fireEvent.keyDown(window, { key: 'Meta', metaKey: true })
    expect(held[0]).toBe(false)
    fireEvent.keyDown(window, { key: 'Control', ctrlKey: true })
    expect(held[0]).toBe(true)
    fireEvent.keyUp(window, { key: 'Control', ctrlKey: false })
    expect(held[0]).toBe(false)
  })
})
