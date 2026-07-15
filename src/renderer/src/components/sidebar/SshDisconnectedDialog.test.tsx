// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SshDisconnectedDialog } from './SshDisconnectedDialog'

const toastMocks = vi.hoisted(() => ({
  error: vi.fn()
}))

const environmentSshMocks = vi.hoisted(() => ({
  connectRuntimeEnvironmentSshTarget: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: {
    error: toastMocks.error
  }
}))

vi.mock('@/runtime/runtime-environment-ssh-state', () => environmentSshMocks)

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

describe('SshDisconnectedDialog', () => {
  beforeEach(() => {
    toastMocks.error.mockReset()
    environmentSshMocks.connectRuntimeEnvironmentSshTarget.mockReset()
  })

  afterEach(() => {
    cleanup()
  })

  it('keeps the dialog open when a runtime reconnect does not reach connected', async () => {
    environmentSshMocks.connectRuntimeEnvironmentSshTarget.mockResolvedValue(null)
    const onOpenChange = vi.fn()
    const user = userEvent.setup()

    render(
      <SshDisconnectedDialog
        open
        onOpenChange={onOpenChange}
        targetId="ssh-p8"
        targetLabel="p8"
        status="disconnected"
        sshOwnerEnvironmentId="linux-jae"
      />
    )

    await user.click(screen.getByRole('button', { name: 'Reconnect' }))

    await waitFor(() => expect(toastMocks.error).toHaveBeenCalledWith('Reconnection failed'))
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeEnabled()
  })

  it('closes the dialog after a runtime reconnect reaches connected', async () => {
    environmentSshMocks.connectRuntimeEnvironmentSshTarget.mockResolvedValue({
      targetId: 'ssh-p8',
      status: 'connected',
      error: null,
      reconnectAttempt: 0,
      remotePlatform: 'linux'
    })
    const onOpenChange = vi.fn()
    const user = userEvent.setup()

    render(
      <SshDisconnectedDialog
        open
        onOpenChange={onOpenChange}
        targetId="ssh-p8"
        targetLabel="p8"
        status="disconnected"
        sshOwnerEnvironmentId="linux-jae"
      />
    )

    await user.click(screen.getByRole('button', { name: 'Reconnect' }))

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    expect(toastMocks.error).not.toHaveBeenCalled()
  })
})
