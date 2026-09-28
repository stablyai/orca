import type * as RuntimeConnectModule from '../status-bar/runtime-environment-explicit-connect'
// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStore, useStore } from 'zustand'
import { getDefaultSettings } from '../../../../shared/constants'
import type { RemoteRuntimeSharedConnectionDiagnostics } from '../../../../shared/remote-runtime-shared-control-types'
import { ActiveServerConnectionNotice } from './ActiveServerConnectionNotice'

type TestState = {
  settings: ReturnType<typeof getDefaultSettings>
  runtimeEnvironments: { id: string; name: string }[]
  runtimeStatusByEnvironmentId: Map<
    string,
    { status: null; remoteControl?: RemoteRuntimeSharedConnectionDiagnostics }
  >
  fetchRuntimeEnvironmentRepos: () => Promise<{ id: string }[]>
  fetchWorktrees: () => Promise<void>
  fetchWorktreeLineage: () => Promise<void>
}
const { connect, pairedWeb } = vi.hoisted(() => ({ connect: vi.fn(), pairedWeb: { value: false } }))
const store = createStore<TestState>(() => ({
  settings: getDefaultSettings('/tmp'),
  runtimeEnvironments: [],
  runtimeStatusByEnvironmentId: new Map(),
  fetchRuntimeEnvironmentRepos: vi.fn(async () => []),
  fetchWorktrees: vi.fn(async () => {}),
  fetchWorktreeLineage: vi.fn(async () => {})
}))
vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: TestState) => unknown) => useStore(store, selector),
    {
      getState: () => store.getState()
    }
  )
}))
vi.mock('@/lib/desktop-window-chrome', () => ({ isPairedWebClientWindow: () => pairedWeb.value }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('../status-bar/runtime-environment-explicit-connect', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeConnectModule>()),
  connectRuntimeEnvironmentAndRecordStatus: connect
}))
afterEach(cleanup)
beforeEach(() => {
  pairedWeb.value = false
  connect.mockReset().mockResolvedValue(false)
  store.setState({
    settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: 'work' },
    runtimeEnvironments: [{ id: 'work', name: 'Work server' }],
    runtimeStatusByEnvironmentId: new Map([['work', { status: null }]])
  })
})

describe('ActiveServerConnectionNotice', () => {
  it('shows the active host and an explicit reconnect action before opening a workspace', () => {
    render(<ActiveServerConnectionNotice />)
    expect(screen.getByRole('status', { name: 'Work server' }).textContent).toContain(
      'Disconnected'
    )
    expect(screen.getByText(/Connect to open or create workspaces/)).toBeDefined()
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeDefined()
  })

  it.each(['disconnected', 'runtime-unavailable', 'reconnecting'] as const)(
    'reserves the destructive glyph for disconnection and warns when Orca is unavailable (%s)',
    (state) => {
      if (state !== 'disconnected') {
        store.setState({
          runtimeStatusByEnvironmentId: new Map([
            [
              'work',
              {
                status: null,
                remoteControl: {
                  state: state === 'reconnecting' ? 'reconnecting' : 'ready',
                  pendingRequestCount: 0,
                  subscriptionCount: 0,
                  reconnectAttempt: 0,
                  lastConnectedAt: null,
                  lastClose: null,
                  lastError: null
                }
              }
            ]
          ])
        })
      }
      render(<ActiveServerConnectionNotice />)
      const notice = screen.getByRole('status', { name: 'Work server' })
      const icon = notice.querySelector('svg')
      expect(icon?.classList.contains('text-destructive')).toBe(state === 'disconnected')
      expect(icon?.classList.contains('text-yellow-500')).toBe(state === 'runtime-unavailable')
      expect(icon?.classList.contains('lucide-server-off')).toBe(state === 'disconnected')
      expect(icon?.classList.contains('animate-spin')).toBe(state === 'reconnecting')
      expect(notice.classList.contains('border-destructive/50')).toBe(state === 'disconnected')
      expect(notice.textContent).toContain(
        state === 'runtime-unavailable'
          ? 'Orca unavailable'
          : state === 'reconnecting'
            ? 'Reconnecting'
            : 'Disconnected'
      )
    }
  )

  it.each(['local', 'checking', 'paired-web'])('stays hidden for %s contexts', (mode) => {
    if (mode === 'local') {
      store.setState({
        settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: null }
      })
    }
    if (mode === 'checking') {
      store.setState({ runtimeStatusByEnvironmentId: new Map() })
    }
    pairedWeb.value = mode === 'paired-web'
    render(<ActiveServerConnectionNotice />)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('prevents duplicate requests and shows failed reconnect inline', async () => {
    let resolve: (connected: boolean) => void = () => {}
    connect.mockImplementation(
      () =>
        new Promise<boolean>((done) => {
          resolve = done
        })
    )
    render(<ActiveServerConnectionNotice />)
    const button = screen.getByRole('button', { name: 'Reconnect' })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(button.hasAttribute('disabled')).toBe(true)
    expect(connect).toHaveBeenCalledExactlyOnceWith('work', 5000)
    await act(async () => resolve(false))
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false))
    expect(screen.getByText('Remote host is not reachable')).toBeDefined()
  })

  it('dismisses the old host notice when the context changes without reconnecting it', () => {
    render(<ActiveServerConnectionNotice />)
    act(() =>
      store.setState({
        settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: null }
      })
    )
    expect(screen.queryByRole('status')).toBeNull()
    expect(connect).not.toHaveBeenCalled()
  })
})
