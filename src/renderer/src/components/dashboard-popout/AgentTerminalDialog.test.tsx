// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type {
  DashboardCard,
  DashboardCardTerminalInput
} from '../../../../shared/dashboard-snapshot'
import type { AgentDashboardTerminalEscape } from '../../../../shared/ui-chrome-types'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useAppStore } from '@/store'
import { AgentTerminalDialog, AgentTerminalPanel } from './AgentTerminalDialog'

// Why: a stand-in for xterm's textarea listener, which like the real one ignores defaultPrevented.
const xtermKeys = vi.hoisted(() => {
  const received: string[] = []
  return {
    received,
    record: (event: KeyboardEvent): void => {
      received.push(event.key)
    }
  }
})

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
    >
      <div className="xterm">
        <textarea
          data-testid="xterm-input"
          ref={(el) => el?.addEventListener('keydown', xtermKeys.record, true)}
        />
      </div>
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

const initialStoreState = useAppStore.getInitialState()

function setTerminalEscape(mode: AgentDashboardTerminalEscape): void {
  useAppStore.setState({
    settings: createGlobalSettingsFixture({ experimentalAgentDashboardTerminalEscape: mode })
  })
}

// Why: fireEvent cannot set keyCode or timeStamp, which pair an IME's duplicate Esc keydown.
function fireEscKeyDown(
  target: Element,
  init: { key?: string; keyCode: number; timeStamp: number; isComposing?: boolean }
): void {
  const event = new KeyboardEvent('keydown', {
    key: init.key ?? 'Escape',
    code: 'Escape',
    isComposing: init.isComposing ?? false,
    bubbles: true,
    cancelable: true
  })
  Object.defineProperty(event, 'keyCode', { value: init.keyCode })
  Object.defineProperty(event, 'timeStamp', { value: init.timeStamp })
  fireEvent(target, event)
}

afterEach(() => {
  cleanup()
  xtermKeys.received.length = 0
  useAppStore.setState(initialStoreState, true)
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

  it('still reports a closed pane for a local card with no live pty', () => {
    render(
      <AgentTerminalDialog
        card={card({ ptyId: null, hostKind: 'local' })}
        onOpenChange={() => {}}
        onReveal={() => {}}
      />
    )

    expect(screen.getByText(/pane has closed/)).toBeInTheDocument()
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

  it('forwards Esc from the terminal to the agent by default', () => {
    const onOpenChange = vi.fn()
    render(<AgentTerminalDialog card={card()} onOpenChange={onOpenChange} onReveal={() => {}} />)

    fireEvent.keyDown(screen.getByTestId('xterm-input'), { key: 'Escape' })

    expect(onOpenChange).not.toHaveBeenCalled()
    expect(xtermKeys.received).toEqual(['Escape'])
  })

  it('closes on terminal Esc without forwarding it in close-dialog mode', () => {
    setTerminalEscape('close-dialog')
    const onOpenChange = vi.fn()
    render(<AgentTerminalDialog card={card()} onOpenChange={onOpenChange} onReveal={() => {}} />)
    const textarea = screen.getByTestId('xterm-input')

    fireEvent.keyDown(textarea, { key: 'y' })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    fireEvent.keyDown(textarea, { key: 'Escape' })

    expect(xtermKeys.received).toEqual(['y', 'Enter'])
    expect(onOpenChange).toHaveBeenCalledTimes(1)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('leaves an IME-owned Esc to the terminal in close-dialog mode', () => {
    setTerminalEscape('close-dialog')
    const onOpenChange = vi.fn()
    render(<AgentTerminalDialog card={card()} onOpenChange={onOpenChange} onReveal={() => {}} />)

    fireEvent.keyDown(screen.getByTestId('xterm-input'), { key: 'Escape', isComposing: true })

    expect(onOpenChange).not.toHaveBeenCalled()
    expect(xtermKeys.received).toEqual(['Escape'])
  })

  // Why: Chromium on Linux reports the IME-consumed keydown as key 'Process', which Radix ignores.
  it.each(['Escape', 'Process'])(
    'keeps the unmarked duplicate of an IME-cancelling Esc from closing the dialog (%s keydown)',
    (key) => {
      setTerminalEscape('close-dialog')
      const onOpenChange = vi.fn()
      render(<AgentTerminalDialog card={card()} onOpenChange={onOpenChange} onReveal={() => {}} />)
      const textarea = screen.getByTestId('xterm-input')

      // IBus Hangul: a composing 229 keydown, compositionend, then an unmarked Escape/27 from the same press.
      fireEscKeyDown(textarea, { key, keyCode: 229, isComposing: true, timeStamp: 100 })
      fireEvent(textarea, new CompositionEvent('compositionend', { data: '한', bubbles: true }))
      fireEscKeyDown(textarea, { keyCode: 27, timeStamp: 100 })

      expect(onOpenChange).not.toHaveBeenCalled()
      expect(xtermKeys.received).toEqual([key, 'Escape'])

      fireEscKeyDown(textarea, { keyCode: 27, timeStamp: 200 })
      expect(onOpenChange).toHaveBeenCalledTimes(1)
      expect(onOpenChange).toHaveBeenCalledWith(false)
    }
  )

  it('closes on terminal Esc even after an earlier window listener prevented it', () => {
    setTerminalEscape('close-dialog')
    const onOpenChange = vi.fn()
    // Why: the Tasks page's window-capture listener does this; Radix then skips its own dismiss.
    const preventEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
      }
    }
    window.addEventListener('keydown', preventEscape, true)
    try {
      render(<AgentTerminalDialog card={card()} onOpenChange={onOpenChange} onReveal={() => {}} />)
      fireEvent.keyDown(screen.getByTestId('xterm-input'), { key: 'Escape' })
    } finally {
      window.removeEventListener('keydown', preventEscape, true)
    }

    expect(onOpenChange).toHaveBeenCalledTimes(1)
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(xtermKeys.received).toEqual([])
  })

  it('reads the Esc setting live while the dialog is open', () => {
    const onOpenChange = vi.fn()
    render(<AgentTerminalDialog card={card()} onOpenChange={onOpenChange} onReveal={() => {}} />)

    act(() => setTerminalEscape('close-dialog'))
    fireEvent.keyDown(screen.getByTestId('xterm-input'), { key: 'Escape' })

    expect(onOpenChange).toHaveBeenCalledTimes(1)
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(xtermKeys.received).toEqual([])
  })

  it.each<AgentDashboardTerminalEscape>(['send-to-agent', 'close-dialog'])(
    'closes on Esc outside the terminal (%s)',
    (mode) => {
      setTerminalEscape(mode)
      const onOpenChange = vi.fn()
      render(<AgentTerminalDialog card={card()} onOpenChange={onOpenChange} onReveal={() => {}} />)

      fireEvent.keyDown(screen.getByRole('button', { name: 'Open worktree' }), { key: 'Escape' })

      expect(onOpenChange).toHaveBeenCalledWith(false)
    }
  )

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
