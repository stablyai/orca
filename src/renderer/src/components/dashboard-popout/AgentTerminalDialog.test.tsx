// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
      <div className="xterm">
        <textarea
          data-testid="xterm-input"
          ref={(el) => el?.addEventListener('keydown', xtermKeys.record, true)}
        />
      </div>
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

// This prop is the only path carrying relayed host-input facts into the preview; omission silently falls back to client-OS routing.
describe('AgentTerminalDialog', () => {
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

it('shows last messages when a card has no live terminal', () => {
  const { rerender } = render(
    <AgentTerminalPanel
      card={card({
        ptyId: null,
        lastUserMessage: 'Roll out rc-18',
        lastAgentMessage: 'Rollout finished'
      })}
      onOpenChange={() => {}}
      onReveal={() => {}}
    />
  )
  expect(screen.getByText('Roll out rc-18')).toBeInTheDocument()
  expect(screen.getByText('Rollout finished')).toBeInTheDocument()

  rerender(
    <AgentTerminalPanel card={card({ ptyId: null })} onOpenChange={() => {}} onReveal={() => {}} />
  )
  expect(screen.queryByText('Rollout finished')).not.toBeInTheDocument()
})
