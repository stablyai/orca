// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TabGroupEmptyState } from './TabGroupEmptyState'

vi.mock('@/hooks/useShortcutLabel', () => ({
  useShortcutKeyDetails: () => ({ keys: [], doubleTap: false })
}))

afterEach(cleanup)

function renderEmptyState(showNewBrowser: boolean): void {
  render(
    <TabGroupEmptyState
      onNewTerminal={vi.fn()}
      onNewMarkdown={vi.fn()}
      onNewBrowser={vi.fn()}
      showNewBrowser={showNewBrowser}
    />
  )
}

describe('TabGroupEmptyState', () => {
  it('hides browser creation when the workspace does not support it', () => {
    renderEmptyState(false)

    expect(screen.getByText('New Terminal')).toBeDefined()
    expect(screen.getByText('New Markdown Note')).toBeDefined()
    expect(screen.queryByText('New Browser')).toBeNull()
  })

  it('shows browser creation when the workspace supports it', () => {
    renderEmptyState(true)

    expect(screen.getByText('New Browser')).toBeDefined()
  })
})
