// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeEnvironmentStatus } from '../../../../shared/runtime-host-status'
import { createCompatibleRuntimeStatusResponse } from '@/runtime/runtime-compatibility-test-fixture'

const mocks = vi.hoisted(() => {
  const state = {
    runtimeStatusByEnvironmentId: new Map<string, RuntimeEnvironmentStatus>(),
    runtimeEnvironments: [{ id: 'env-a', name: 'Studio PC' }],
    remoteBrowserPageHandlesByPageId: {}
  }
  const useAppStore = <T,>(selector: (s: typeof state) => T): T => selector(state)
  useAppStore.getState = () => state
  return { state, useAppStore, ensure: vi.fn(), ownHostClientId: 'desktop-self' }
})

vi.mock('@/store', () => ({ useAppStore: mocks.useAppStore }))
vi.mock('@/runtime/restored-client-hosted-browser-host-attach', () => ({
  ensureBrowserClientHostOnRuntimeContact: mocks.ensure
}))
vi.mock('@/runtime/browser-client-host-identity', () => ({
  readBrowserClientHostId: () => mocks.ownHostClientId
}))
vi.mock('./browser-reopen-on-server', () => ({ reopenBrowserPageOnServer: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

import { ClientHostedBrowserUnavailableNotice } from './client-hosted-browser-unavailable-notice'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderNotice(
  entry: RuntimeEnvironmentStatus | undefined,
  placementHostClientId: string | null = 'desktop-self'
): void {
  mocks.state.runtimeStatusByEnvironmentId = new Map(entry ? [['env-a', entry]] : [])
  render(
    <ClientHostedBrowserUnavailableNotice
      runtimeEnvironmentId="env-a"
      worktreeId="worktree-a"
      lastCommittedUrl="https://example.internal/"
      placementHostClientId={placementHostClientId}
    />
  )
}

const liveResponse = createCompatibleRuntimeStatusResponse('rt-1')
const live: RuntimeEnvironmentStatus = {
  status: liveResponse.ok ? liveResponse.result : null,
  checkedAt: 1
}

describe('ClientHostedBrowserUnavailableNotice', () => {
  it('says the host is offline while contact is lost', () => {
    renderNotice({ status: null, checkedAt: 1 })

    expect(
      screen.getByText('Studio PC is offline. This page will reload here once it reconnects.')
    ).toBeInTheDocument()
    expect(mocks.ensure).not.toHaveBeenCalled()
  })

  it('does not promise a reconnect for a retired pairing', () => {
    renderNotice({
      status: null,
      checkedAt: 1,
      snapshot: {
        environmentId: 'env-a',
        pairingRevision: 1,
        sequence: 1,
        checkedAt: 1,
        transport: 'disconnected',
        verification: 'unavailable',
        status: null,
        retired: true
      }
    })

    expect(
      screen.getByText("This page isn't available on this desktop right now.")
    ).toBeInTheDocument()
  })

  it('names another desktop only when the placement belongs to one', () => {
    renderNotice(live, 'desktop-other')

    expect(screen.getByText('This page is open on another desktop.')).toBeInTheDocument()
    expect(mocks.ensure).not.toHaveBeenCalled()
  })

  // Why: a lease reconnect that fails after contact already returned has no later edge to re-host.
  it('shows the generic copy and re-claims hosting once while the host is reachable', () => {
    renderNotice(live)

    expect(
      screen.getByText("This page isn't available on this desktop right now.")
    ).toBeInTheDocument()
    expect(mocks.ensure).toHaveBeenCalledTimes(1)
    expect(mocks.ensure).toHaveBeenCalledWith(expect.anything(), 'env-a')
  })
})
