// @vitest-environment happy-dom

/**
 * The hook, not the pure resolver: what it repairs depends on where focus went
 * after it left a row, and only a real DOM can answer that.
 */

import { act, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useAutomationListFocusRecovery } from './use-automation-list-focus-recovery'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function Harness({ rowKeys }: { rowKeys: readonly string[] }): React.JSX.Element {
  const listRef = useRef<HTMLDivElement>(null)
  const pickerRef = useRef<HTMLDivElement>(null)
  useAutomationListFocusRecovery({ rowKeys, containerRef: listRef, fallbackRef: pickerRef })
  return (
    <div>
      {/* The header: outside the list container, exactly as the panel lays it out. */}
      <div ref={pickerRef}>
        <button type="button" data-testid="picker" />
      </div>
      <input data-testid="search" />
      <div ref={listRef}>
        {rowKeys.map((rowKey) => (
          <div key={rowKey} tabIndex={0} data-automation-row-id={rowKey} data-testid={rowKey} />
        ))}
      </div>
    </div>
  )
}

function render(rowKeys: readonly string[]): void {
  act(() => {
    root.render(<Harness rowKeys={rowKeys} />)
  })
}

function node(testId: string): HTMLElement {
  const found = container.querySelector<HTMLElement>(`[data-testid="${testId}"]`)
  if (!found) {
    throw new Error(`no node for ${testId}`)
  }
  return found
}

function focus(testId: string): void {
  act(() => {
    node(testId).focus()
  })
}

describe('useAutomationListFocusRecovery', () => {
  it('leaves focus in the search field when filtering removes the row it was on', () => {
    render(['r1', 'r2', 'r3'])
    focus('r2')
    focus('search')
    const search = node('search')

    render(['r1', 'r3'])

    expect(document.activeElement).toBe(search)
  })

  it('still repairs focus lost from the list itself', () => {
    render(['r1', 'r2', 'r3'])
    focus('r2')
    act(() => {
      node('r2').blur()
    })

    render(['r1', 'r3'])

    expect(document.activeElement).toBe(node('r3'))
  })
})
