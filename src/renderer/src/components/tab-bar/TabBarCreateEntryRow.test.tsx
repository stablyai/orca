// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { ActiveOption } from './tab-create-entry-active-option'
import { EntryActionRow } from './TabBarCreateEntryRow'

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
