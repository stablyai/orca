// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshManagedServerStatus } from '../../../../shared/ssh-types'
import type {
  PlainSshTerminalEvent,
  PlainSshTerminalOpenResult
} from '../../../../shared/plain-ssh-terminal'
import { OpenPlainSshTerminalButton } from './OpenPlainSshTerminalButton'
import { PlainSshTerminalPanels } from './PlainSshTerminalPanels'
import { removePlainSshPanel } from '@/ssh/plain-ssh-terminal-panels'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../shared/constants'

const written: string[] = []

// The standalone terminal is the preview's, covered by its tests; this stands in for xterm.
vi.mock('@/components/standalone-terminal/open-standalone-terminal', () => ({
  openStandaloneTerminal: () => ({
    terminal: {
      options: {},
      cols: 80,
      rows: 24,
      loadAddon: () => {},
      focus: () => {},
      onResize: () => ({ dispose: () => {} })
    },
    write: (chunk: string, options: { onDone?: () => void }) => {
      written.push(chunk)
      options.onDone?.()
    },
    dispose: () => {}
  })
}))
const fit = vi.fn()
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit(): void {
      fit()
    }
  }
}))

const blocked: SshManagedServerStatus = {
  kind: 'relay',
  reason: 'refused',
  detail: 'This SSH host cannot move yet: automations (2).'
}

let emit: (event: PlainSshTerminalEvent) => void = () => {}
const open = vi.fn<(args: unknown) => Promise<PlainSshTerminalOpenResult>>()
const close = vi.fn()
const ack = vi.fn()

beforeEach(() => {
  written.length = 0
  open.mockReset()
  close.mockReset()
  ack.mockReset()
  Object.defineProperty(window, 'ResizeObserver', {
    configurable: true,
    // Full surface: a hovered header button's Tooltip positions itself with unobserve too.
    value: class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      plainSsh: {
        open,
        close,
        ack,
        write: vi.fn(),
        resize: vi.fn(),
        onEvent: (callback: (event: PlainSshTerminalEvent) => void) => {
          emit = callback
          return () => {}
        }
      }
    }
  })
})

afterEach(() => {
  act(() => removePlainSshPanel('lambda'))
  cleanup()
})

/** The open reply arrives when the test says, so nothing races it. */
function deferOpen(): (result: PlainSshTerminalOpenResult) => void {
  let resolve: (result: PlainSshTerminalOpenResult) => void = () => {}
  open.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done
      })
  )
  return (result) => resolve(result)
}

function Harness({ status }: { status: SshManagedServerStatus | undefined }): React.JSX.Element {
  return (
    <TooltipProvider>
      <OpenPlainSshTerminalButton targetId="lambda" targetLabel="lambda" status={status} />
      <PlainSshTerminalPanels />
    </TooltipProvider>
  )
}

describe('plain SSH terminal', () => {
  it('is offered only while the host’s move is blocked, and only for this desktop’s host', () => {
    const { rerender } = render(<Harness status={undefined} />)
    expect(screen.queryByRole('button', { name: 'Open plain SSH terminal' })).toBeNull()
    rerender(<Harness status={{ kind: 'managed', environmentId: 'e' }} />)
    expect(screen.queryByRole('button', { name: 'Open plain SSH terminal' })).toBeNull()
    rerender(<Harness status={{ ...blocked, bridged: true }} />)
    expect(screen.queryByRole('button', { name: 'Open plain SSH terminal' })).toBeNull()
    rerender(
      <OpenPlainSshTerminalButton
        targetId="lambda"
        targetLabel="lambda"
        status={blocked}
        ownerEnvironmentId="env-1"
      />
    )
    expect(screen.queryByRole('button', { name: 'Open plain SSH terminal' })).toBeNull()
  })

  it('opens a labelled unmanaged window, shows early output, and closes when ssh exits cleanly', async () => {
    let resolveOpen: (result: PlainSshTerminalOpenResult) => void = () => {}
    open.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveOpen = resolve
        })
    )
    const user = userEvent.setup()
    render(<Harness status={blocked} />)
    await user.click(screen.getByRole('button', { name: 'Open plain SSH terminal' }))

    expect(screen.getByText('Plain SSH · lambda')).toBeInTheDocument()
    expect(screen.getByText(/Plain SSH — unmanaged\. Not an Orca workspace/)).toBeInTheDocument()
    expect(open).toHaveBeenCalledWith({ targetId: 'lambda', cols: 80, rows: 24 })

    // ssh can print before the open reply arrives.
    act(() => emit({ kind: 'data', sessionId: 's1', data: 'Enter passphrase: ' }))
    await act(async () => resolveOpen({ ok: true, sessionId: 's1', label: 'lambda' }))
    expect(written).toEqual(['Enter passphrase: '])
    // Rendered output is acked, so main resumes a paused ssh.
    expect(ack).toHaveBeenCalledWith({ sessionId: 's1', chars: 'Enter passphrase: '.length })

    act(() => emit({ kind: 'exit', sessionId: 's1', exitCode: 0 }))
    await waitFor(() => expect(screen.queryByText('Plain SSH · lambda')).toBeNull())
  })

  it('keeps output when ssh is killed by a signal, even with exit code 0', async () => {
    const resolveOpen = deferOpen()
    const user = userEvent.setup()
    render(<Harness status={blocked} />)
    await user.click(screen.getByRole('button', { name: 'Open plain SSH terminal' }))
    await waitFor(() => expect(open).toHaveBeenCalled())
    await act(async () => resolveOpen({ ok: true, sessionId: 's4', label: 'lambda' }))
    act(() => emit({ kind: 'exit', sessionId: 's4', exitCode: 0, signal: 9 }))
    expect(await screen.findByText(/ssh was stopped \(signal 9\)/)).toBeInTheDocument()
  })

  it('still ends a session whose exit arrives before its open reply', async () => {
    let resolveOpen: (result: PlainSshTerminalOpenResult) => void = () => {}
    open.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveOpen = resolve
        })
    )
    const user = userEvent.setup()
    render(<Harness status={blocked} />)
    await user.click(screen.getByRole('button', { name: 'Open plain SSH terminal' }))
    act(() => {
      // A flood from another window's session must not crowd out this session's exit.
      emit({ kind: 'data', sessionId: 'other', data: 'y'.repeat(300 * 1024) })
      emit({ kind: 'data', sessionId: 's5', data: 'Permission denied (publickey).\r\n' })
      emit({ kind: 'exit', sessionId: 's5', exitCode: 255 })
    })
    await act(async () => resolveOpen({ ok: true, sessionId: 's5', label: 'lambda' }))
    expect(await screen.findByText(/ssh exited with code 255/)).toBeInTheDocument()
    expect(written).toEqual(['Permission denied (publickey).\r\n'])
  })

  it('keeps a failed login readable, with no shell to fall back to', async () => {
    const resolveOpen = deferOpen()
    const user = userEvent.setup()
    render(<Harness status={blocked} />)
    await user.click(screen.getByRole('button', { name: 'Open plain SSH terminal' }))
    await waitFor(() => expect(open).toHaveBeenCalled())
    await act(async () => resolveOpen({ ok: true, sessionId: 's2', label: 'lambda' }))
    act(() => emit({ kind: 'exit', sessionId: 's2', exitCode: 255 }))
    expect(await screen.findByText(/ssh exited with code 255/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Close and end session' }))
    expect(screen.queryByText('Plain SSH · lambda')).toBeNull()
  })

  it('never refits a minimized window, which would shrink the remote terminal to 2x1', async () => {
    const width = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(600)
    const height = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(400)
    try {
      const resolveOpen = deferOpen()
      const user = userEvent.setup()
      render(<Harness status={blocked} />)
      await user.click(screen.getByRole('button', { name: 'Open plain SSH terminal' }))
      await act(async () => resolveOpen({ ok: true, sessionId: 's6', label: 'lambda' }))
      await user.click(screen.getByRole('button', { name: 'Minimize' }))
      fit.mockClear()
      act(() =>
        useAppStore.setState({
          settings: { ...getDefaultSettings('/home/me'), terminalFontSize: 18 }
        })
      )
      expect(fit).not.toHaveBeenCalled()
    } finally {
      width.mockRestore()
      height.mockRestore()
    }
  })

  it('shows why it can’t open, e.g. no OpenSSH on Windows', async () => {
    open.mockResolvedValue({
      ok: false,
      reason: 'ssh-missing',
      message: 'Orca couldn’t find OpenSSH (ssh.exe) on this computer.'
    })
    const user = userEvent.setup()
    render(<Harness status={blocked} />)
    await user.click(screen.getByRole('button', { name: 'Open plain SSH terminal' }))
    expect(await screen.findByText(/couldn’t find OpenSSH/)).toBeInTheDocument()
  })

  it('hangs up when its window closes', async () => {
    const resolveOpen = deferOpen()
    const user = userEvent.setup()
    render(<Harness status={blocked} />)
    await user.click(screen.getByRole('button', { name: 'Open plain SSH terminal' }))
    await waitFor(() => expect(open).toHaveBeenCalled())
    await act(async () => resolveOpen({ ok: true, sessionId: 's3', label: 'lambda' }))
    await user.click(screen.getByRole('button', { name: 'Close and end session' }))
    expect(close).toHaveBeenCalledWith({ sessionId: 's3' })
  })
})
