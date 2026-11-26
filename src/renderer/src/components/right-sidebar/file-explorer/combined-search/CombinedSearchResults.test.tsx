// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SearchResult } from '../../../../../../shared/file-search/code-search-types'
import { buildSearchRows } from '../content-search/search-rows'
import { CombinedSearchResults } from './CombinedSearchResults'
import { COMBINED_SEARCH_LISTBOX_ID, createCombinedSearchRows } from './combined-search-rows'
import type { NameMatchRowActions } from './use-name-match-row-actions'

const noop = (): void => {}
const ROW_ACTIONS: NameMatchRowActions = {
  open: noop,
  copyPaths: noop,
  startNew: noop,
  startRename: noop,
  duplicate: noop,
  requestDelete: noop,
  dragStart: noop,
  canOpenInOrcaBrowser: () => false,
  deleteShortcutLabel: '',
  connectionId: null,
  runtimeDownloadContext: null
}
const WRAPPED_ERROR_HEIGHT = 60

function rectOf(height: number): DOMRect {
  return DOMRect.fromRect({ x: 0, y: 0, width: 300, height })
}

function heightOf(element: HTMLElement): number {
  if (element.hasAttribute('data-combined-search-results')) {
    return 400
  }
  if (element.hasAttribute('data-index')) {
    return element.querySelector('[role="alert"]') ? WRAPPED_ERROR_HEIGHT : 24
  }
  return 24
}

beforeEach(() => {
  // happy-dom has no layout: give the list a viewport and make the red error row wrap to two lines.
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    return heightOf(this)
  })
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(300)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    return rectOf(heightOf(this))
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function translateY(element: Element): number {
  const transform = element instanceof HTMLElement ? element.style.transform : ''
  const match = /translateY\(([\d.]+)px\)/.exec(transform)
  return match ? Number(match[1]) : Number.NaN
}

describe('combined search results layout', () => {
  it('pushes rows below a wrapped error down instead of overlapping it', async () => {
    const files: SearchResult = { totalMatches: 0, truncated: false, files: [] }
    const model = createCombinedSearchRows({
      names: {
        total: 1,
        matches: [{ relativePath: 'src/cart.ts', name: 'cart.ts', dir: 'src', ranges: [] }]
      },
      textResult: files,
      textRows: buildSearchRows(files, new Set()),
      textPending: false,
      textError: 'rg exited with code 2 while scanning a very long path that wraps'
    })
    const { container } = render(
      <CombinedSearchResults
        model={model}
        activeIndex={-1}
        listboxId={COMBINED_SEARCH_LISTBOX_ID}
        onActivateRow={noop}
        rowActions={ROW_ACTIONS}
        toNode={() => null}
        workspaceId={null}
        onMenuClosed={noop}
      />
    )
    await act(async () => {})

    const rows = [...container.querySelectorAll('[data-index]')]
    const errorIndex = rows.findIndex((row) => row.querySelector('[role="alert"]'))
    expect(errorIndex).toBeGreaterThan(0)
    // The error is the last row; the list must reserve its wrapped height, not the one-line estimate.
    const listHeight = Number.parseFloat(
      container.querySelector<HTMLElement>('[role="listbox"]')?.style.height ?? ''
    )
    expect(listHeight).toBeGreaterThanOrEqual(translateY(rows[errorIndex]) + WRAPPED_ERROR_HEIGHT)
  })
})
