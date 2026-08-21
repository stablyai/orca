// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type {
  DashboardCard,
  DashboardCardTerminalInput
} from '../../../../shared/dashboard-snapshot'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { AgentTerminalDialog, AgentTerminalPanel } from './AgentTerminalDialog'

// Stub the preview so the assertion is on the props the dialog hands it, with
// no xterm / IPC machinery in the way.
vi.mock('./AgentTerminalPreview', () => ({
  AgentTerminalPreview: ({
    ptyId,
    terminalInput,
    className
  }: {
    ptyId: string
    terminalInput?: DashboardCardTerminalInput | null
    className?: string
  }) => (
    <div
      data-testid="preview"
      data-pty-id={ptyId}
      data-terminal-input={terminalInput === null ? 'null' : JSON.stringify(terminalInput)}
      className={className}
    />
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

// Why: this is the only seam carrying the relayed host profile into the
// emulator. Dropping the prop degrades every preview to client-OS byte routing
// silently — nothing else in the app reads DashboardCard.terminalInput.
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

  it('passes null when the card carries no profile, so the preview routes by client OS', () => {
    render(<AgentTerminalDialog card={card()} onOpenChange={() => {}} onReveal={() => {}} />)

    expect(screen.getByTestId('preview')).toHaveAttribute('data-terminal-input', 'null')
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
