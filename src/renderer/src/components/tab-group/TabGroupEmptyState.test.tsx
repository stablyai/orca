// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TabGroupEmptyState } from './TabGroupEmptyState'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('@/hooks/useShortcutLabel', () => ({
  useShortcutKeyDetails: () => ({ keys: ['Ctrl', 'T'], doubleTap: false })
}))

afterEach(cleanup)

describe('TabGroupEmptyState', () => {
  it('offers a direct new-terminal action when the workspace has no tabs left', () => {
    const onNewTerminalTab = vi.fn()
    render(<TabGroupEmptyState onNewTerminalTab={onNewTerminalTab} />)

    expect(screen.getByText('No open tabs')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: /New terminal/ }))

    expect(onNewTerminalTab).toHaveBeenCalledTimes(1)
  })

  it('renders the platform shortcut chips supplied by the keybinding hook', () => {
    render(<TabGroupEmptyState onNewTerminalTab={vi.fn()} />)

    expect(screen.getByText('Ctrl')).toBeDefined()
    expect(screen.getByText('T')).toBeDefined()
  })
})
