// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { BitbucketIntegrationCard } from './bitbucket-integration-card'

type CardHost = { target: RuntimeClientTarget; followsWorkspace: boolean }

const mocks = vi.hoisted(() => {
  const card: { host: CardHost | null } = { host: null }
  return { card, refresh: vi.fn(), status: vi.fn(), connect: vi.fn(), disconnect: vi.fn() }
})

vi.mock('./source-control-preflight-card-status', () => ({
  usePreflightCardStatuses: () => ({
    statuses: { bitbucketStatus: 'not-configured', bitbucketAccount: null },
    unavailable: false,
    host: mocks.card.host,
    refresh: mocks.refresh
  })
}))
vi.mock('@/runtime/source-control/bitbucket/runtime-bitbucket-credentials-client', () => ({
  bitbucketCredentialStatus: mocks.status,
  bitbucketConnect: mocks.connect,
  bitbucketDisconnect: mocks.disconnect,
  BitbucketCredentialsHostOutdatedError: class extends Error {}
}))

const NOT_CONFIGURED = {
  configured: false,
  source: 'none',
  credentialProtection: null,
  account: null,
  authMode: null,
  email: null,
  baseUrl: null
}

async function connectWithToken(): Promise<void> {
  render(
    <TooltipProvider>
      <BitbucketIntegrationCard />
    </TooltipProvider>
  )
  fireEvent.click(await screen.findByRole('button', { name: 'Connect' }))
  fireEvent.click(await screen.findByRole('radio', { name: /access token/i }))
  fireEvent.change(await screen.findByPlaceholderText(/token/i), {
    target: { value: 'secret' }
  })
  const submit = screen
    .getAllByRole('button', { name: 'Connect' })
    .find((button) => button.closest('[role="dialog"]'))!
  fireEvent.click(submit)
  await waitFor(() => expect(mocks.connect).toHaveBeenCalledTimes(1))
}

describe('Bitbucket card host wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.status.mockResolvedValue(NOT_CONFIGURED)
    mocks.connect.mockResolvedValue({ ok: true, account: 'dev' })
  })

  afterEach(() => {
    cleanup()
    useAppStore.setState(useAppStore.getInitialState(), true)
  })

  it('saves to the server whose status the badge shows, even when Settings points elsewhere', async () => {
    const wsl: RuntimeClientTarget = { kind: 'environment', environmentId: 'wsl-host' }
    // Settings on this computer, a WSL-server workspace focused: the badge is the WSL server's.
    mocks.card.host = { target: wsl, followsWorkspace: true }

    await connectWithToken()

    expect(mocks.status).toHaveBeenCalledWith(wsl)
    expect(mocks.connect).toHaveBeenCalledWith(wsl, expect.objectContaining({ authMode: 'token' }))
    // The post-save refresh must re-read the same host and its preflight.
    await waitFor(() => expect(mocks.status).toHaveBeenCalledTimes(2))
    expect(mocks.status).toHaveBeenLastCalledWith(wsl)
    expect(mocks.refresh).toHaveBeenCalled()
  })

  it('keeps this computer on its own target', async () => {
    mocks.card.host = { target: { kind: 'local' }, followsWorkspace: false }

    await connectWithToken()

    expect(mocks.status).toHaveBeenCalledWith({ kind: 'local' })
    expect(mocks.connect).toHaveBeenCalledWith({ kind: 'local' }, expect.anything())
  })
})
