// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { SshManagedServerStatus } from '../../../../shared/ssh-types'
import { useAppStore } from '@/store'
import { resetSshConnectInFlightForTests } from '@/ssh/ssh-connect-in-flight'

const toastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { error: toastError } }))

import NodeDistMirrorDialog from './NodeDistMirrorDialog'
import { SshHostNodeMirrorAction } from './SshHostNodeMirrorAction'
import { toastSshConnectFailure } from '@/ssh/ssh-connect-failure-toast'

const blocked: SshManagedServerStatus = {
  kind: 'relay',
  reason: 'failed',
  detail: 'Neither this computer nor the host could download Node.',
  nodeDownloadBlocked: { mirror: 'unset' }
}

const settingsSet = vi.fn(async (updates: Partial<GlobalSettings>) => ({
  ...useAppStore.getState().settings,
  ...updates
}))
const connect = vi.fn(async () => ({ targetId: 'ssh-1', status: 'connected' }))

function settingsWithMirror(nodeDistMirrorUrl: string): GlobalSettings {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these components read only nodeDistMirrorUrl.
  return { nodeDistMirrorUrl } as GlobalSettings
}

function Host({ status }: { status: SshManagedServerStatus }) {
  const open = useAppStore((s) => s.activeModal === 'node-dist-mirror')
  return (
    <>
      <SshHostNodeMirrorAction targetId="ssh-1" status={status} />
      {open ? <NodeDistMirrorDialog /> : null}
    </>
  )
}

beforeEach(() => {
  settingsSet.mockClear()
  connect.mockClear()
  toastError.mockClear()
  Object.assign(window, {
    api: { ...window.api, settings: { set: settingsSet }, ssh: { connect } }
  })
  useAppStore.setState({ settings: settingsWithMirror('') })
})

afterEach(() => {
  cleanup()
  act(() => useAppStore.getState().closeModal())
  resetSshConnectInFlightForTests()
})

function openDialog(): HTMLInputElement {
  fireEvent.click(screen.getByRole('button', { name: 'Use a Node.js mirror…' }))
  return screen.getByLabelText('Mirror URL')
}

describe('Use a Node.js mirror', () => {
  it('opens from the host row with the suggested mirror, focused and editable', () => {
    render(<Host status={blocked} />)
    const input = openDialog()

    expect(screen.getByRole('dialog', { name: 'Use a Node.js mirror' })).toBeInTheDocument()
    expect(input).toHaveValue('https://npmmirror.com/mirrors/node/')
    expect(input).toHaveFocus()
    expect(screen.getByText(/checked against the checksum Orca pins/)).toBeInTheDocument()
  })

  it('saves to the mirror setting, then retries the connect and closes', async () => {
    render(<Host status={blocked} />)
    openDialog()

    fireEvent.click(screen.getByRole('button', { name: 'Save and retry' }))

    await waitFor(() => expect(connect).toHaveBeenCalledWith({ targetId: 'ssh-1' }))
    expect(settingsSet).toHaveBeenCalledWith({
      nodeDistMirrorUrl: 'https://npmmirror.com/mirrors/node'
    })
    expect(settingsSet.mock.invocationCallOrder[0]).toBeLessThan(
      connect.mock.invocationCallOrder[0]
    )
    expect(useAppStore.getState().settings?.nodeDistMirrorUrl).toBe(
      'https://npmmirror.com/mirrors/node'
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('submits with Enter and refuses a URL the setting would refuse', async () => {
    render(<Host status={blocked} />)
    const input = openDialog()

    fireEvent.change(input, { target: { value: 'https://me:secret@mirror.example/node' } })
    fireEvent.submit(input.closest('form')!)

    expect(
      await screen.findByText('Mirror URL cannot contain a user name or password.')
    ).toBeInTheDocument()
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(settingsSet).not.toHaveBeenCalled()
    expect(connect).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { value: 'https://mirror.example/node/' } })
    expect(input).not.toHaveAttribute('aria-invalid')
    fireEvent.submit(input.closest('form')!)
    await waitFor(() =>
      expect(settingsSet).toHaveBeenCalledWith({ nodeDistMirrorUrl: 'https://mirror.example/node' })
    )
  })

  it('cancels without saving, also with Escape', async () => {
    render(<Host status={blocked} />)
    openDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    const input = openDialog()
    fireEvent.keyDown(input, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(settingsSet).not.toHaveBeenCalled()
    expect(connect).not.toHaveBeenCalled()
  })

  it('shows no offer once a mirror was tried, only the setting link', () => {
    const tried: SshManagedServerStatus = { ...blocked, nodeDownloadBlocked: { mirror: 'tried' } }
    useAppStore.getState().setSshConnectionState('ssh-1', {
      targetId: 'ssh-1',
      status: 'error',
      error: 'x',
      reconnectAttempt: 0,
      managedServer: tried
    })
    render(<Host status={tried} />)
    expect(screen.queryByRole('button', { name: 'Use a Node.js mirror…' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open mirror setting' }))
    const state = useAppStore.getState()
    expect(state.activeView).toBe('settings')
    expect(state.settingsNavigationTarget).toMatchObject({ pane: 'advanced' })
    expect(state.settingsSearchInputQuery).toBe('mirror')
    expect(state.activeModal).toBe('none')
  })

  it('offers nothing in a paired browser, whose settings are not this computer’s', () => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
    try {
      render(<Host status={blocked} />)
      expect(screen.queryByRole('button')).toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('opens the setting instead when a mirror was set after the toast appeared', () => {
    useAppStore.getState().setSshConnectionState('ssh-1', {
      targetId: 'ssh-1',
      status: 'error',
      error: 'x',
      reconnectAttempt: 0,
      managedServer: blocked
    })
    toastSshConnectFailure('ssh-1', new Error('x'), 'Connection failed')
    const [, options] = toastError.mock.calls[0]
    useAppStore.setState({
      settings: settingsWithMirror('https://m.example/node')
    })
    act(() => options.action.onClick())
    expect(useAppStore.getState().activeModal).toBe('none')
    expect(useAppStore.getState().activeView).toBe('settings')
  })

  it('puts the same recovery on the connect-failure toast for this computer’s targets', () => {
    useAppStore.getState().setSshConnectionState('ssh-1', {
      targetId: 'ssh-1',
      status: 'error',
      error: 'x',
      reconnectAttempt: 0,
      managedServer: blocked
    })
    toastSshConnectFailure('ssh-1', new Error('x'), 'Connection failed')
    const [text, options] = toastError.mock.calls[0]
    expect(text).toContain('Use a Node.js mirror')
    act(() => options.action.onClick())
    expect(useAppStore.getState().activeModal).toBe('node-dist-mirror')
    expect(useAppStore.getState().modalData).toEqual({ targetId: 'ssh-1' })

    toastError.mockClear()
    toastSshConnectFailure('ssh-1', new Error('x'), 'Connection failed', 'server-env')
    expect(toastError.mock.calls[0]).toHaveLength(1)
  })
})
