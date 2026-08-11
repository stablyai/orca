// @vitest-environment happy-dom

/**
 * Guards the sub-option indent: Tailwind v4 emits `px-*` as `padding-inline`,
 * which outranks a physical `pl-*` override and silently flattens the nesting.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FilterToggleRow } from './FilterToggleRow'

let container: HTMLDivElement
let root: Root

function renderRow(indented: boolean): HTMLElement {
  act(() => {
    root.render(
      <FilterToggleRow
        icon={null}
        label="Row"
        checked={false}
        onChange={vi.fn()}
        indented={indented}
      />
    )
  })
  const row = container.querySelector('[role="switch"]')
  if (!(row instanceof HTMLElement)) {
    throw new Error('FilterToggleRow did not render a switch')
  }
  return row
}

function paddingClasses(row: HTMLElement): string[] {
  return row.className.split(/\s+/).filter((cls) => /^p[xlr]?-/.test(cls))
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('FilterToggleRow', () => {
  it('indents a sub-option past the row above it', () => {
    const indented = paddingClasses(renderRow(true))
    const flat = paddingClasses(renderRow(false))
    expect(indented).toContain('pl-7')
    expect(flat).toContain('pl-2')
  })

  it('never pairs the indent with a padding-inline utility that would outrank it', () => {
    expect(paddingClasses(renderRow(true)).filter((cls) => cls.startsWith('px-'))).toEqual([])
  })
})
