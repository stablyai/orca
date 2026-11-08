// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type {
  DashboardCard,
  DashboardCardTerminalInput
} from '../../../../shared/dashboard-snapshot'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useAppStore } from '@/store'
import { AgentTerminalDialog, AgentTerminalPanel } from './AgentTerminalDialog'

// Stub xterm/IPC to inspect the routing props passed to the preview.
vi.mock('./AgentTerminalPreview', () => ({
  AgentTerminalPreview: ({
    ptyId,
    terminalInput,
    className,
    onBrowserForeground
  }: {
    ptyId: string
    terminalInput?: DashboardCardTerminalInput | null
    className?: string
    onBrowserForeground?: () => void
  }) => (
    <div
      data-testid="preview"
      data-pty-id={ptyId}
      data-terminal-input={terminalInput === null ? 'null' : JSON.stringify(terminalInput)}
      className={className}
    >
      {onBrowserForeground ? (
        <button onClick={onBrowserForeground}>Completed browser handoff</button>
      ) : null}
    </div>
  )
}))

function card(overrides: Partial<DashboardCard> = {}): DashboardCard {
  return {
    paneKey: 'tab1:leaf1',
    ptyId: 'pty-1',
    agentType: 'claude',
    bucket: 'working',
    dotState: 'working',
    task: 'task',
    repoId: 'r1',
    worktreeId: 'w1',
    tabId: 'tab1',
    leafId: 'leaf1',
    repoName: 'Repo',
    worktreeName: 'wt',
    startedAt: 0,
    finishedAt: null,
    stateChangedAt: 0,
    unseen: false,
    ...overrides
  }
}

afterEach(() => {
  cleanup()
  useAppStore.setState({ keybindings: {} })
})

// This prop is the only path carrying relayed host-input facts into the preview; omission silently falls back to client-OS routing.
describe('AgentTerminalDialog', () => {
  it('lets a nested Radix layer consume Escape before closing the panel', () => {
    const onOpenChange = vi.fn()
    render(
      <>
        <AgentTerminalPanel card={card()} onOpenChange={onOpenChange} onReveal={() => {}} />
        <Popover defaultOpen>
          <PopoverTrigger>Details</PopoverTrigger>
          <PopoverContent>Worktree details</PopoverContent>
        </Popover>
      </>
    )

    fireEvent.keyDown(screen.getByText('Worktree details'), { key: 'Escape' })

    expect(screen.queryByText('Worktree details')).not.toBeInTheDocument()
    expect(onOpenChange).not.toHaveBeenCalled()

    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('closes the preview with its custom terminal shortcut', () => {
    useAppStore.setState({
      keybindings: { 'dashboard.closeTerminal': ['Mod+Alt+B'] }
    })
    function Host() {
      const [open, setOpen] = useState(true)
      return open ? (
        <AgentTerminalPanel card={card()} onOpenChange={setOpen} onReveal={() => {}} />
      ) : (
        <p>Agents board</p>
      )
    }
    render(<Host />)

    fireEvent.keyDown(screen.getByTestId('preview'), {
      key: 'b',
      code: 'KeyB',
      ctrlKey: true,
      altKey: true
    })

    expect(screen.getByText('Agents board')).toBeInTheDocument()
    expect(screen.queryByTestId('preview')).not.toBeInTheDocument()
  })

  it('closes the preview with a double-tap modifier shortcut', () => {
    useAppStore.setState({
      keybindings: { 'dashboard.closeTerminal': ['DoubleTap+Ctrl'] }
    })
    function Host() {
      const [open, setOpen] = useState(true)
      return open ? (
        <AgentTerminalPanel card={card()} onOpenChange={setOpen} onReveal={() => {}} />
      ) : (
        <p>Agents board</p>
      )
    }
    render(<Host />)
    const preview = screen.getByTestId('preview')
    const firstTap = { key: 'Control', code: 'ControlLeft', ctrlKey: true }

    fireEvent.keyDown(preview, firstTap)
    fireEvent.keyUp(preview, firstTap)
    fireEvent.keyDown(preview, firstTap)

    expect(screen.getByText('Agents board')).toBeInTheDocument()
    expect(screen.queryByTestId('preview')).not.toBeInTheDocument()
  })
})

it.each([false, true])(
  'restores dialog focus only without a confirmed host handoff (%s)',
  async (handoff) => {
    function Host() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button onClick={() => setOpen(true)}>Launch preview</button>
          <button id="browser-destination">Browser destination</button>
          <AgentTerminalDialog
            card={open ? card() : null}
            onOpenChange={setOpen}
            onReveal={() => {}}
            onBrowserForeground={
              handoff ? () => document.getElementById('browser-destination')?.focus() : undefined
            }
          />
        </>
      )
    }
    render(<Host />)
    const launch = screen.getByRole('button', { name: 'Launch preview' })
    launch.focus()
    fireEvent.click(launch)
    await waitFor(() => expect(screen.getByTestId('preview')).toBeInTheDocument())
    fireEvent.click(
      screen.getByRole('button', { name: handoff ? 'Completed browser handoff' : 'Close' })
    )
    await waitFor(() => expect(screen.queryByTestId('preview')).not.toBeInTheDocument())
    await waitFor(() =>
      expect(document.activeElement).toBe(
        handoff ? document.getElementById('browser-destination') : launch
      )
    )
  }
)
