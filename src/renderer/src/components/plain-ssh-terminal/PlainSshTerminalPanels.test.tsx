// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshManagedServerStatus } from '../../../../shared/remote-runtime/ssh/ssh-types'
import type {
  PlainSshTerminalEvent,
  PlainSshTerminalOpenResult
} from '../../../../shared/terminal/runtime/plain-ssh-terminal'
import { OpenPlainSshTerminalButton } from './OpenPlainSshTerminalButton'
import { PlainSshTerminalPanels } from './PlainSshTerminalPanels'
import { removePlainSshPanel } from '@/ssh/plain-ssh-terminal-panels'
import { TooltipProvider } from '@/components/ui/tooltip'

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
      onResize: () => ({ dispose: () => {} }),
      onScroll: () => ({ dispose: () => {} }),
      onWriteParsed: () => ({ dispose: () => {} }),
      buffer: {
        active: { type: 'normal', baseY: 0 },
        onBufferChange: () => ({ dispose: () => {} })
      }
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

function Harness({ status }: { status: SshManagedServerStatus | undefined }): React.JSX.Element {
  return (
    <TooltipProvider>
      <OpenPlainSshTerminalButton targetId="lambda" targetLabel="lambda" status={status} />
      <PlainSshTerminalPanels />
    </TooltipProvider>
  )
}

describe('plain SSH terminal', () => {
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
    await user.click(screen.getByRole('button', { name: 'Plain SSH terminal' }))

    expect(screen.getByText('Plain SSH · lambda')).toBeInTheDocument()
    expect(screen.getByText(/Plain SSH — unmanaged\. Not an Orca workspace/)).toBeInTheDocument()
    expect(open).toHaveBeenCalledWith({ targetId: 'lambda', cols: 80, rows: 24 })

    // ssh can print before the open reply arrives.
    act(() => emit({ kind: 'data', sessionId: 's1', data: 'Enter passphrase: ' }))
    await act(async () => resolveOpen({ ok: true, sessionId: 's1', label: 'lambda' }))
    expect(written).toEqual(['Enter passphrase: '])
    expect(ack).toHaveBeenCalledWith({ sessionId: 's1', chars: 'Enter passphrase: '.length })

    act(() => emit({ kind: 'exit', sessionId: 's1', exitCode: 0 }))
    await waitFor(() => expect(screen.queryByText('Plain SSH · lambda')).toBeNull())
  })
})
