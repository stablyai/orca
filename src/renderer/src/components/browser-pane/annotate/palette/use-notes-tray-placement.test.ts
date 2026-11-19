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

describe('where the notes list opens', () => {
  it('opens just under the note count, aligned with it', () => {
    const ref = pageWithChipAt(200)
    const { result } = renderHook(() => useNotesTrayPlacement(ref, true))

    expect(result.current).toMatchObject({ top: 42, left: 200, width: 320, bottom: 'auto' })
  })

  it('stays inside the page area when the palette sits at the right edge', () => {
    const ref = pageWithChipAt(760)
    const { result } = renderHook(() => useNotesTrayPlacement(ref, true))

    expect(result.current).toMatchObject({ left: 800 - 320 - 12 })
  })

  it('keeps the default corner while the list is closed', () => {
    const ref = pageWithChipAt(200)
    const { result } = renderHook(() => useNotesTrayPlacement(ref, false))

    expect(result.current).toBeUndefined()
  })
})
