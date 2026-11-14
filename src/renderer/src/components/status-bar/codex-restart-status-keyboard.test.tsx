// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { CodexRestartStatusPrompt } from './StatusBarAccountControls'

const { state } = vi.hoisted(() => ({
  state: {
    tabsByWorktree: { workspace: [{ id: 'tab-1' }] },
    ptyIdsByTabId: { 'tab-1': ['pty-1'] },
    codexRestartNoticeByPtyId: {
      'pty-1': { previousAccountLabel: 'old', nextAccountLabel: 'new' }
    },
    queuePaneAccountRestarts: vi.fn()
  }
}))

vi.mock('../../store', () => ({
  useAppStore: (selector: (value: typeof state) => unknown) => selector(state)
}))

afterEach(cleanup)

describe('Codex restart banner keyboard action', () => {
  it('reaches the restart action with arrow keys and activates it once with Enter', async () => {
    render(
      <DropdownMenu defaultOpen modal={false}>
        <DropdownMenuTrigger>Accounts</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Previous action</DropdownMenuItem>
          <CodexRestartStatusPrompt />
        </DropdownMenuContent>
      </DropdownMenu>
    )
    const previous = await screen.findByRole('menuitem', { name: 'Previous action' })
    previous.focus()
    fireEvent.keyDown(previous, { key: 'ArrowDown' })
    const restart = screen.getByRole('menuitem', { name: 'Restart Session' })
    await waitFor(() => expect(document.activeElement).toBe(restart))
    fireEvent.keyDown(restart, { key: 'Enter' })
    expect(state.queuePaneAccountRestarts).toHaveBeenCalledExactlyOnceWith(['pty-1'], 'codex')
    expect(screen.getByRole('menuitem', { name: 'Restart Session' })).toBeTruthy()
  })
})
