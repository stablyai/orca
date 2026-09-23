// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TabGroupEmptyState } from './TabGroupEmptyState'

vi.mock('@/hooks/useShortcutLabel', () => ({
  useShortcutKeyDetails: () => ({ keys: [], doubleTap: false })
}))

globalThis.IS_REACT_ACT_ENVIRONMENT = true

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

function renderEmptyState(showNewBrowser: boolean): void {
  act(() => {
    root.render(
      <TabGroupEmptyState
        onNewTerminal={vi.fn()}
        onNewMarkdown={vi.fn()}
        onNewBrowser={vi.fn()}
        showNewBrowser={showNewBrowser}
      />
    )
  })
}

describe('TabGroupEmptyState', () => {
  it('hides browser creation when the workspace does not support it', () => {
    renderEmptyState(false)

    expect(container.textContent).toContain('New Terminal')
    expect(container.textContent).toContain('New Markdown Note')
    expect(container.textContent).not.toContain('New Browser')
  })

  it('shows browser creation when the workspace supports it', () => {
    renderEmptyState(true)

    expect(container.textContent).toContain('New Browser')
  })
})
