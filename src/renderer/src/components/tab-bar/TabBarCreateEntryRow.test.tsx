// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { ActiveOption } from './tab-create-entry-active-option'
import { cursorTooltipOffsets, EntryActionRow } from './TabBarCreateEntryRow'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const filePath = 'app/src/components/SecondaryNav.tsx'

function makeFileOption(path: string): ActiveOption {
  return {
    kind: 'entry',
    option: {
      id: `existing-file:${path}`,
      classification: {
        kind: 'existing-file',
        matchKind: 'fuzzy',
        relativePath: path
      }
    }
  }
}

// The tooltip itself is asserted in tests/e2e/tab-create-entry-file-paths.spec.ts,
// where it actually opens; here we only need the row's own text layout.
function renderRow(option: ActiveOption): HTMLButtonElement {
  act(() => {
    root.render(
      createElement(
        TooltipProvider,
        null,
        createElement(EntryActionRow, {
          id: 'file-result',
          onClick: vi.fn(),
          option,
          selected: false
        })
      )
    )
  })

  const button = container.querySelector('button')
  if (!button) {
    throw new Error('row did not render a button')
  }
  return button
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('EntryActionRow', () => {
  it('puts the filename before the truncated parent path', () => {
    const text = renderRow(makeFileOption(filePath)).textContent ?? ''

    expect(text.indexOf('SecondaryNav.tsx')).toBeLessThan(text.indexOf('app/src/components/'))
  })

  it('does not duplicate the root separator for absolute root-level files', () => {
    const text = renderRow(makeFileOption('/foo')).textContent ?? ''

    expect(text).toContain('foo/')
    expect(text).not.toContain('foo//')
  })

  it('keeps Windows separators intact', () => {
    const text = renderRow(makeFileOption('C:\\repo\\src\\SecondaryNav.tsx')).textContent ?? ''

    expect(text.indexOf('SecondaryNav.tsx')).toBeLessThan(text.indexOf('C:\\repo\\src\\'))
  })

  it('renders a bare filename without a directory fragment', () => {
    expect(renderRow(makeFileOption('README.md')).textContent).toContain('README.md')
    expect(container.textContent).not.toContain('/')
  })
})

describe('cursorTooltipOffsets', () => {
  const row = { bottom: 120, left: 400 }

  it('places the tooltip under the cursor rather than the row', () => {
    // Row-anchored placement would be align 0; the cursor is 64px into the row.
    expect(cursorTooltipOffsets({ x: 464, y: 108 }, row)).toEqual({ align: 64, side: 6 })
  })

  it('tracks the cursor across the row', () => {
    const left = cursorTooltipOffsets({ x: 410, y: 108 }, row)
    const right = cursorTooltipOffsets({ x: 610, y: 108 }, row)

    expect(right.align - left.align).toBe(200)
    expect(right.side).toBe(left.side)
  })

  it('stays anchored to the cursor when the row moves under it', () => {
    // The dropdown reflows while results stream in; re-measuring the row must
    // keep the tooltip on the cursor, not drag it along with the row.
    const before = cursorTooltipOffsets({ x: 464, y: 108 }, row)
    const after = cursorTooltipOffsets({ x: 464, y: 108 }, { bottom: 148, left: 576 })

    expect(row.left + before.align).toBe(576 + after.align)
    expect(row.bottom + before.side).toBe(148 + after.side)
  })
})
