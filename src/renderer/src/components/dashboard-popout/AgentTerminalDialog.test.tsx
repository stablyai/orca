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

const TERMINAL_INPUT: DashboardCardTerminalInput = {
  hostPlatform: 'win32',
  localWindowsConpty: true,
  osRelease: '10.0.22631',
  windowsShiftEnterEncoding: 'csi-u',
  ctrlEnterCsiU: false,
  kittyKeyboardAdvertised: false
}

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
})

// This prop is the only path carrying relayed host-input facts into the preview; omission silently falls back to client-OS routing.
describe('AgentTerminalDialog', () => {
  it("hands the card's relayed host-input profile to the preview terminal", () => {
    render(
      <AgentTerminalDialog
        card={card({ terminalInput: TERMINAL_INPUT })}
        onOpenChange={() => {}}
        onReveal={() => {}}
      />
    )

    expect(screen.getByTestId('preview')).toHaveAttribute(
      'data-terminal-input',
      JSON.stringify(TERMINAL_INPUT)
    )
  })

  it.each([
    ['interrupted', 'Interrupted'],
    ['failed', 'Failed'],
    ['unconfirmed', 'Couldn’t confirm']
  ] as const)('keeps an acknowledged %s verdict in the terminal header', (verdict, label) => {
    const statusCard = { ...card({ dotState: 'done', bucket: 'idle', unseen: false }), verdict }
    render(<AgentTerminalPanel card={statusCard} onOpenChange={() => {}} onReveal={() => {}} />)
    expect(screen.getByText(new RegExp(label))).toBeInTheDocument()
  })

  it('passes null when the card carries no profile, so the preview routes by client OS', () => {
    render(<AgentTerminalDialog card={card()} onOpenChange={() => {}} onReveal={() => {}} />)

    expect(screen.getByTestId('preview')).toHaveAttribute('data-terminal-input', 'null')
  })

  it('does not claim a remote pane closed when the card carries no live pty', () => {
    render(
      <AgentTerminalDialog
        card={card({ ptyId: null, hostKind: 'ssh' })}
        onOpenChange={() => {}}
        onReveal={() => {}}
      />
    )

    // Loss of contact with an SSH host is `unverifiable`, never `exited`.
    expect(screen.getByText(/remote session/)).toBeInTheDocument()
    expect(screen.queryByText(/pane has closed/)).not.toBeInTheDocument()
  })

  it('keeps a local agent openable without claiming its missing preview means closure', () => {
    render(
      <AgentTerminalDialog
        card={card({ ptyId: null, hostKind: 'local' })}
        onOpenChange={() => {}}
        onReveal={() => {}}
      />
    )

    expect(screen.getByText(/No preview available/)).toBeInTheDocument()
    expect(screen.queryByText(/pane has closed/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open worktree' })).toBeEnabled()
  })

  it('labels acknowledged completions idle without review or pin controls', () => {
    render(
      <AgentTerminalDialog
        card={card({ bucket: 'idle', dotState: 'done', finishedAt: 100, unseen: false })}
        onOpenChange={() => {}}
        onReveal={() => {}}
      />
    )

    expect(screen.getByText(/Claude · Idle/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Keep visible' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Mark reviewed' })).not.toBeInTheDocument()
    expect(screen.getByTestId('preview')).toHaveAttribute('data-pty-id', 'pty-1')
  })

  it('labels unseen completions done', () => {
    render(
      <AgentTerminalDialog
        card={card({ bucket: 'done', dotState: 'done', finishedAt: 100, unseen: true })}
        onOpenChange={() => {}}
        onReveal={() => {}}
      />
    )

    expect(screen.getByText(/Claude · Done/)).toBeInTheDocument()
  })

  it('preserves the execution host when revealing a colliding worktree ID', () => {
    const onReveal = vi.fn()
    render(
      <AgentTerminalDialog
        card={card({ executionHostId: 'runtime:env-1' })}
        onOpenChange={() => {}}
        onReveal={onReveal}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Open worktree' }))
    expect(onReveal).toHaveBeenCalledWith({
      repoId: 'r1',
      worktreeId: 'w1',
      executionHostId: 'runtime:env-1',
      tabId: 'tab1',
      leafId: 'leaf1'
    })
  })

  it('reuses the terminal surface as a non-modal adjacent panel', () => {
    render(<AgentTerminalPanel card={card()} onOpenChange={() => {}} onReveal={() => {}} />)

    expect(screen.getByRole('dialog', { name: 'wt' })).toHaveAttribute('data-state', 'open')
    expect(screen.getByTestId('preview')).toHaveClass('min-h-0', 'flex-1')
    expect(document.querySelector('[data-slot="dialog-overlay"]')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'wt' })).toBeInTheDocument()
  })

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
