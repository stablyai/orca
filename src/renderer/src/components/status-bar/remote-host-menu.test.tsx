// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { TooltipProvider } from '@/components/ui/tooltip'
import { RemoteHostStatusRow } from './RemoteHostStatusRow'
import { RuntimeHostStatusRow } from './RuntimeHostStatusRow'
import { SshTargetStatusRow, connectSshTargetFromStatusMenu } from './SshTargetStatusRow'
import { useRemoteHostMenuState } from './use-remote-host-menu-state'
import { toastSshConnectFailure } from '@/ssh/ssh-connect-failure-toast'
import { resetSshConnectInFlightForTests } from '@/ssh/ssh-connect-in-flight'

vi.mock('../../store', () => ({
  useAppStore: { getState: () => ({ recordFeatureInteraction: vi.fn() }) }
}))
vi.mock('@/ssh/ssh-connect-failure-toast', () => ({ toastSshConnectFailure: vi.fn() }))
const hostExists = () => true
const id = 'ssh:host'

function Hosts({
  open = true,
  attempt = 1,
  recovering = true
}: {
  open?: boolean
  attempt?: number
  recovering?: boolean
}) {
  const menu = useRemoteHostMenuState(open, hostExists)
  menu.observe([{ id, recovering, attempt }])
  return (
    <TooltipProvider>
      <DropdownMenu open={open} modal={false}>
        <DropdownMenuTrigger>Hosts</DropdownMenuTrigger>
        <DropdownMenuContent>
          <RemoteHostStatusRow
            label="Host"
            tone={recovering ? 'busy' : 'connected'}
            status="Connection state"
            actionLabel="Stop"
            actionKind="disconnect"
            onAction={vi.fn()}
            recovery={menu.observations.get(id)}
            now={menu.now}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </TooltipProvider>
  )
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.clearAllMocks()
  resetSshConnectInFlightForTests()
})

it('keeps recovery age across handshake and menu reopening, with either threshold and a success reset', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(10_000)
  const view = render(<Hosts />)
  const row = () => screen.getByRole('menuitem', { name: 'Host, Connection state' })
  expect(row().getAttribute('aria-haspopup')).toBeNull()
  await act(() => vi.advanceTimersByTimeAsync(29_000))
  view.rerender(<Hosts attempt={0} />)
  expect(row().getAttribute('aria-haspopup')).toBeNull()
  view.rerender(<Hosts open={false} attempt={0} />)
  await act(() => vi.advanceTimersByTimeAsync(2_000))
  view.rerender(<Hosts attempt={0} />)
  expect(row().getAttribute('aria-haspopup')).toBe('menu')
  view.rerender(<Hosts recovering={false} attempt={0} />)
  view.rerender(<Hosts attempt={2} />)
  expect(row().getAttribute('aria-haspopup')).toBeNull()
  view.rerender(<Hosts attempt={3} />)
  expect(row().getAttribute('aria-haspopup')).toBe('menu')
  view.rerender(<Hosts attempt={0} />)
  expect(row().getAttribute('aria-haspopup')).toBe('menu')
})

it('keeps the primary action independently keyboard reachable beside an open error submenu', async () => {
  const retry = vi.fn()
  const copy = vi.fn(async () => undefined)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { ui: { writeClipboardText: copy } }
  })
  render(
    <TooltipProvider>
      <DropdownMenu defaultOpen modal={false}>
        <DropdownMenuTrigger>Hosts</DropdownMenuTrigger>
        <DropdownMenuContent>
          <RemoteHostStatusRow
            label="Host"
            tone="error"
            status="Error"
            actionLabel="Retry"
            actionKind="connect"
            onAction={retry}
            errorSentence="Connection unavailable."
            rawDetail="fixture raw error"
            now={0}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </TooltipProvider>
  )
  const row = screen.getByRole('menuitem', { name: 'Host, Error' })
  row.focus()
  fireEvent.keyDown(row, { key: 'ArrowDown' })
  const action = screen.getByRole('menuitem', { name: 'Retry Host' })
  await vi.waitFor(() => expect(document.activeElement).toBe(action))
  await act(async () => fireEvent.keyDown(action, { key: 'Enter' }))
  expect(retry).toHaveBeenCalledTimes(1)
  row.focus()
  fireEvent.keyDown(row, { key: 'ArrowRight' })
  const copyAction = await screen.findByRole('menuitem', { name: 'Copy error' })
  fireEvent.keyDown(copyAction, { key: 'Enter' })
  expect(copy).toHaveBeenCalledWith('fixture raw error')
  await act(async () => fireEvent.click(action))
  expect(retry).toHaveBeenCalledTimes(2)
})

function PendingSshHost() {
  const menu = useRemoteHostMenuState(true, hostExists)
  return (
    <TooltipProvider>
      <DropdownMenu defaultOpen modal={false}>
        <DropdownMenuTrigger>Hosts</DropdownMenuTrigger>
        <DropdownMenuContent>
          <SshTargetStatusRow
            targetId="host"
            label="Host"
            status="disconnected"
            now={0}
            pending={menu.pending.has(id)}
            onConnect={() =>
              menu.connect(id, (signal) => connectSshTargetFromStatusMenu('host', signal))
            }
            onDisconnect={async () => {
              menu.cancel(id)
              await window.api.ssh.disconnect({ targetId: 'host' })
            }}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </TooltipProvider>
  )
}

it('keeps Stop usable before the connect status arrives and suppresses its late failure', async () => {
  let rejectConnect: (error: Error) => void = () => undefined
  const request = new Promise<never>((_, reject) => {
    rejectConnect = reject
  })
  const disconnect = vi.fn(async () => undefined)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      ssh: {
        connect: vi.fn(() => request),
        disconnect
      }
    }
  })
  render(<PendingSshHost />)
  await act(async () => fireEvent.click(screen.getByRole('menuitem', { name: 'Connect Host' })))
  await act(async () => fireEvent.click(screen.getByRole('menuitem', { name: 'Stop Host' })))
  expect(disconnect).toHaveBeenCalledWith({ targetId: 'host' })
  await act(async () => rejectConnect(new Error('cancelled fixture attempt')))
  expect(toastSshConnectFailure).not.toHaveBeenCalled()
  expect(screen.getByRole('menuitem', { name: 'Connect Host' })).toBeTruthy()
})

it('shows connected hosts as connected while their explicit connect is still settling', () => {
  render(
    <TooltipProvider>
      <DropdownMenu defaultOpen modal={false}>
        <DropdownMenuTrigger>Hosts</DropdownMenuTrigger>
        <DropdownMenuContent>
          <RuntimeHostStatusRow
            label="Server"
            state="connected"
            pending
            recovery={{ since: 1, attempt: 7 }}
            now={60_000}
            onConnect={vi.fn()}
            onDisconnect={vi.fn()}
            onRecover={vi.fn()}
          />
          <SshTargetStatusRow
            targetId="host"
            label="SSH"
            status="connected"
            pending
            recovery={{ since: 1, attempt: 7 }}
            now={60_000}
            onConnect={vi.fn()}
            onDisconnect={vi.fn()}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </TooltipProvider>
  )
  expect(screen.getByRole('menuitem', { name: 'Disconnect Server' })).toBeTruthy()
  expect(screen.getByRole('menuitem', { name: 'Disconnect SSH' })).toBeTruthy()
  expect(
    screen.getByRole('menuitem', { name: 'Server, Connected' }).hasAttribute('aria-haspopup')
  ).toBe(false)
  expect(
    screen.getByRole('menuitem', { name: 'SSH, Connected' }).hasAttribute('aria-haspopup')
  ).toBe(false)
  expect(screen.queryByRole('menuitem', { name: /Stop/ })).toBeNull()
})

it('clears the old unavailable card while Retry is connecting, then shows only eligible recovery', () => {
  const row = (attempt: number) => (
    <TooltipProvider>
      <DropdownMenu defaultOpen modal={false}>
        <DropdownMenuTrigger>Hosts</DropdownMenuTrigger>
        <DropdownMenuContent>
          <RuntimeHostStatusRow
            label="Server"
            state="runtime-unavailable"
            pending
            recovery={{ since: 10_000, attempt }}
            now={10_001}
            onConnect={vi.fn()}
            onDisconnect={vi.fn()}
            onRecover={vi.fn()}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </TooltipProvider>
  )
  const view = render(row(0))
  expect(screen.getByRole('menuitem', { name: 'Stop Server' })).toBeTruthy()
  const trigger = screen.getByRole('menuitem', { name: 'Server, Checking' })
  expect(trigger.hasAttribute('aria-haspopup')).toBe(false)
  view.rerender(row(3))
  const reconnecting = screen.getByRole('menuitem', { name: 'Server, Reconnecting (attempt 3)' })
  fireEvent.keyDown(reconnecting, { key: 'ArrowRight' })
  expect(screen.getByRole('menuitem', { name: 'Retry now' })).toBeTruthy()
  expect(screen.queryByRole('menuitem', { name: 'Copy error' })).toBeNull()
})

it('keeps its reconnect submenu actionable when the pointer transfers from the row', async () => {
  const retry = vi.fn(async () => undefined)
  render(
    <TooltipProvider>
      <DropdownMenu defaultOpen modal={false}>
        <DropdownMenuTrigger>Hosts</DropdownMenuTrigger>
        <DropdownMenuContent>
          <RemoteHostStatusRow
            label="Host"
            tone="busy"
            status="Reconnecting"
            actionLabel="Stop"
            actionKind="disconnect"
            onAction={vi.fn()}
            recovery={{ since: 0, attempt: 3 }}
            now={60_000}
            onRetry={retry}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </TooltipProvider>
  )
  const row = screen.getByRole('menuitem', { name: 'Host, Reconnecting' })
  fireEvent.pointerMove(row, { pointerType: 'mouse', clientX: 20, clientY: 20 })
  const action = await screen.findByRole('menuitem', { name: 'Retry now' })
  act(() => row.focus())
  fireEvent.pointerOut(row, {
    pointerType: 'mouse',
    relatedTarget: action,
    clientX: 30,
    clientY: 20
  })
  fireEvent.pointerOver(action, {
    pointerType: 'mouse',
    relatedTarget: row,
    clientX: 31,
    clientY: 20
  })
  await act(async () => fireEvent.click(action))
  expect(retry).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('menuitem', { name: 'Stop Host' })).toBeTruthy()
})
