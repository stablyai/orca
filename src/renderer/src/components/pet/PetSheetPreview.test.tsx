// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PetSheetPreview } from './PetSheetPreview'

let root: Root | null = null
let container: HTMLDivElement | null = null

function render(): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root?.render(
      <PetSheetPreview
        sheetUrl="data:image/webp;base64,SHEET"
        frame={{ width: 48, height: 48 }}
        rows={7}
        size={180}
      />
    )
  })
}

function surface(): HTMLElement {
  const el = container?.querySelector('[data-preview-row]')
  if (!el) {
    throw new Error('no preview surface')
  }
  return el as HTMLElement
}

/** Runs the tour forward until the surface is showing `row`. */
function advanceToRow(row: number): void {
  for (let step = 0; step < 12; step++) {
    if (surface().getAttribute('data-preview-row') === String(row)) {
      return
    }
    act(() => {
      vi.advanceTimersByTime(2000)
    })
  }
  throw new Error(`tour never reached row ${row}`)
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  if (root) {
    act(() => root?.unmount())
  }
  container?.remove()
  root = null
  container = null
  vi.useRealTimers()
})

describe('PetSheetPreview', () => {
  it('plays getting up once, the way the overlay does', () => {
    // Why: `rising` is a one-shot row — the overlay pins its last frame. Looping
    // it in the preview shows the pet standing up over and over.
    render()

    advanceToRow(6)

    expect(surface().style.animation).not.toContain('infinite')
    expect(surface().style.animation).toContain('forwards')
  })

  it('loops the rows that are meant to cycle', () => {
    render()

    advanceToRow(1)

    expect(surface().style.animation).toContain('infinite')
  })
})
