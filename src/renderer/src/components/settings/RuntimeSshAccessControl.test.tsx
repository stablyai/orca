// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import { RuntimeSshAccessControl } from './RuntimeSshAccessControl'

const mocks = vi.hoisted(() => ({
  isWeb: vi.fn(() => false),
  setTargets: vi.fn(),
  listTargets: vi.fn(),
  link: vi.fn(),
  unlink: vi.fn()
}))

vi.mock('@/lib/web-client-location', () => ({ isWebClientLocation: mocks.isWeb }))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ setSshTargetsMetadata: mocks.setTargets }) }
}))

const tunnel = {
  sshTargetId: 'ssh-host',
  sshTargetGeneration: 4,
  localPort: 32100,
  remotePort: 7788
}

function environment(
  overrides: Partial<PublicKnownRuntimeEnvironment> = {}
): PublicKnownRuntimeEnvironment {
  return {
    id: 'paired-host',
    name: 'Independent host',
    runtimeId: 'host-runtime',
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    preferredEndpointId: 'direct',
    endpoints: [{ id: 'direct', kind: 'websocket', label: 'Direct', endpoint: 'ws://host:7788' }],
    ...overrides
  }
}

function pendingEnvironment(operation: 'link' | 'unlink'): PublicKnownRuntimeEnvironment {
  return environment({
    pendingSshAccessOperation: {
      operation,
      requestId: 'durable-request',
      sshTargetId: tunnel.sshTargetId,
      sshTargetGeneration: tunnel.sshTargetGeneration,
      remotePort: tunnel.remotePort,
      targetFingerprint: 'host-fingerprint'
    }
  })
}

async function openControl(host: PublicKnownRuntimeEnvironment, onChanged = vi.fn(async () => {})) {
  render(<RuntimeSshAccessControl environment={host} disabled={false} onChanged={onChanged} />)
  fireEvent.click(screen.getByRole('button', { name: /SSH access/ }))
  await screen.findByText('Independent host')
  return onChanged
}

describe('RuntimeSshAccessControl', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.isWeb.mockReturnValue(false)
    mocks.listTargets.mockResolvedValue([])
    mocks.link.mockResolvedValue(environment())
    mocks.unlink.mockResolvedValue(environment())
    vi.stubGlobal('api', undefined)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        ssh: { listTargets: mocks.listTargets },
        runtimeEnvironments: { linkSshAccess: mocks.link, unlinkSshAccess: mocks.unlink }
      }
    })
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('retries a pending link using its durable request, target, and native port', async () => {
    const onChanged = await openControl(pendingEnvironment('link'))
    expect(mocks.listTargets).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce())
    expect(mocks.link).toHaveBeenCalledExactlyOnceWith({
      selector: 'paired-host',
      requestId: 'durable-request',
      sshTargetId: 'ssh-host',
      remotePort: 7788
    })
    await waitFor(() => expect(mocks.setTargets).toHaveBeenCalledWith([]))
    expect(mocks.unlink).not.toHaveBeenCalled()
  })

  it('cancels a pending link through unlink with the original request ID', async () => {
    const onChanged = await openControl(pendingEnvironment('link'))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel link' }))
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce())
    expect(mocks.unlink).toHaveBeenCalledExactlyOnceWith({
      selector: 'paired-host',
      requestId: 'durable-request'
    })
    expect(mocks.link).not.toHaveBeenCalled()
  })

  it('retries a pending unlink without offering link cancellation', async () => {
    await openControl(pendingEnvironment('unlink'))
    expect(screen.queryByRole('button', { name: 'Cancel link' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() =>
      expect(mocks.unlink).toHaveBeenCalledExactlyOnceWith({
        selector: 'paired-host',
        requestId: 'durable-request'
      })
    )
    expect(mocks.link).not.toHaveBeenCalled()
  })

  it('unlinks active access without selecting a new target', async () => {
    await openControl(
      environment({
        connectionDependency: 'ssh-tunnel',
        preferredEndpointId: 'tunnel',
        sshAccess: { ...tunnel, endpointId: 'tunnel', previousPreferredEndpointId: 'direct' }
      })
    )
    expect(mocks.listTargets).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Unlink SSH' }))
    await waitFor(() =>
      expect(mocks.unlink).toHaveBeenCalledExactlyOnceWith({
        selector: 'paired-host',
        requestId: expect.any(String)
      })
    )
  })

  it('refreshes after failed verification so a newly persisted intent is discoverable', async () => {
    mocks.link.mockRejectedValue(new Error('Host identity could not be verified'))
    const onChanged = await openControl(pendingEnvironment('link'))
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce())
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Host identity could not be verified'
    )
    await waitFor(() => expect(mocks.setTargets).toHaveBeenCalledWith([]))
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
  })

  it('refuses duplicate mutations until both the operation and refresh finish', async () => {
    let resolveLink!: () => void
    let resolveRefresh!: () => void
    mocks.link.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveLink = resolve
      })
    )
    const onChanged = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRefresh = resolve
        })
    )
    await openControl(pendingEnvironment('link'), onChanged)
    const retry = screen.getByRole('button', { name: 'Retry' })
    fireEvent.click(retry)
    fireEvent.click(retry)
    expect(mocks.link).toHaveBeenCalledOnce()
    expect((retry as HTMLButtonElement).disabled).toBe(true)
    await act(async () => {
      resolveLink()
    })
    fireEvent.click(retry)
    expect(mocks.link).toHaveBeenCalledOnce()
    expect(mocks.unlink).not.toHaveBeenCalled()
    await act(async () => {
      resolveRefresh()
    })
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull())
  })

  it('loads targets only after an unlinked form is opened', async () => {
    render(
      <RuntimeSshAccessControl environment={environment()} disabled={false} onChanged={vi.fn()} />
    )
    expect(mocks.listTargets).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'SSH access' }))
    await waitFor(() => expect(mocks.listTargets).toHaveBeenCalledOnce())
    expect((screen.getByRole('button', { name: 'Link SSH' }) as HTMLButtonElement).disabled).toBe(
      true
    )
  })

  it('keeps the initial request ID on failure and uses the selected target and native port', async () => {
    mocks.listTargets.mockResolvedValue([
      { id: 'unused', label: 'Unused host' },
      { id: 'owned', label: 'Owned host', owner: { environmentId: 'another' } },
      { id: 'installing', label: 'Installing host', orcadProvisioning: { requestId: 'install' } }
    ])
    mocks.link.mockRejectedValue(new Error('Host is not reachable'))
    await openControl(environment())
    await waitFor(() =>
      expect((screen.getByRole('combobox') as HTMLButtonElement).disabled).toBe(false)
    )
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' })
    expect(screen.queryByRole('option', { name: 'Owned host' })).toBeNull()
    expect(screen.queryByRole('option', { name: 'Installing host' })).toBeNull()
    fireEvent.click(await screen.findByRole('option', { name: 'Unused host' }))
    fireEvent.change(screen.getByLabelText('Server port'), { target: { value: '8877' } })
    fireEvent.click(screen.getByRole('button', { name: 'Link SSH' }))
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Link SSH' }) as HTMLButtonElement).disabled).toBe(
        false
      )
    )
    expect(mocks.link).toHaveBeenCalledExactlyOnceWith({
      selector: 'paired-host',
      requestId: expect.any(String),
      sshTargetId: 'unused',
      remotePort: 8877
    })
    fireEvent.click(screen.getByRole('button', { name: 'Link SSH' }))
    await waitFor(() => expect(mocks.link).toHaveBeenCalledTimes(2))
    expect(mocks.link.mock.calls[1]).toEqual(mocks.link.mock.calls[0])
  })

  it.each(['managed', 'web'] as const)('hides access changes for %s clients', (kind) => {
    mocks.isWeb.mockReturnValue(kind === 'web')
    render(
      <RuntimeSshAccessControl
        environment={environment(kind === 'managed' ? { orcadDeployment: tunnel } : {})}
        disabled={false}
        onChanged={vi.fn()}
      />
    )
    expect(screen.queryByRole('button', { name: /SSH access/ })).toBeNull()
    expect(mocks.listTargets).not.toHaveBeenCalled()
  })
})
