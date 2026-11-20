// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useNotesTrayPlacement } from './use-notes-tray-placement'

afterEach(() => {
  document.body.innerHTML = ''
})

function pageWithChipAt(chipLeft: number): { current: HTMLElement } {
  const container = document.createElement('div')
  container.getBoundingClientRect = () => new DOMRect(100, 50, 800, 600)
  const palette = document.createElement('div')
  palette.setAttribute('data-browser-annotate-palette', '')
  const chip = document.createElement('button')
  chip.setAttribute('data-browser-annotate-notes-chip', '')
  chip.getBoundingClientRect = () => new DOMRect(100 + chipLeft, 58, 70, 28)
  palette.append(chip)
  container.append(palette)
  document.body.append(container)
  return { current: container }
}

describe('notes list placement computed from the chip and page rects it is given', () => {
  it('returns a place 6px under the chip rect, left-aligned with it', () => {
    const ref = pageWithChipAt(200)
    const { result } = renderHook(() => useNotesTrayPlacement(ref, true))

    expect(result.current).toMatchObject({ top: 42, left: 200, width: 320, bottom: 'auto' })
  })

  it('clamps the returned left edge inside the page rect for a chip at the right edge', () => {
    const ref = pageWithChipAt(760)
    const { result } = renderHook(() => useNotesTrayPlacement(ref, true))

    expect(result.current).toMatchObject({ left: 468 })
  })

  it('returns no placement while the list is closed', () => {
    const ref = pageWithChipAt(200)
    const { result } = renderHook(() => useNotesTrayPlacement(ref, false))

    expect(result.current).toBeUndefined()
  })
})
