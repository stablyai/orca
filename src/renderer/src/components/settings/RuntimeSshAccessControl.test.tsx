// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import type { ManagedOrcadPreloadApi } from '../../../../preload/api/managed-orcad-api'
import { RuntimeSshAccessControl } from './RuntimeSshAccessControl'

function environment(
  pendingSshAccessOperation: PublicKnownRuntimeEnvironment['pendingSshAccessOperation']
): PublicKnownRuntimeEnvironment {
  return {
    id: 'env-a',
    name: 'fight PC',
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    runtimeId: 'runtime-a',
    endpoints: [{ id: 'ws', kind: 'websocket', label: 'Tailscale', endpoint: 'ws://a:6768' }],
    preferredEndpointId: 'ws',
    pendingSshAccessOperation
  }
}

const pendingLink = {
  requestId: 'request-1',
  operation: 'link' as const,
  sshTargetId: 'ssh-weknora',
  sshTargetGeneration: 3,
  remotePort: 6768,
  targetFingerprint: 'fingerprint'
}

function renderControl(env: PublicKnownRuntimeEnvironment) {
  const linkSshAccess = vi.fn(async () => env)
  const unlinkSshAccess = vi.fn(async () => env)
  const onChanged = vi.fn()
  const api: Pick<ManagedOrcadPreloadApi, 'linkSshAccess' | 'unlinkSshAccess'> = {
    linkSshAccess,
    unlinkSshAccess
  }
  render(<RuntimeSshAccessControl api={api} environment={env} targets={[]} onChanged={onChanged} />)
  return { linkSshAccess, unlinkSshAccess, onChanged }
}

afterEach(cleanup)

// #27765: an unfinished link blocked removing the server and offered no way out.
describe('an unfinished SSH access link', () => {
  it('cancels the recorded operation by its own request id', async () => {
    const { unlinkSshAccess, onChanged } = renderControl(environment(pendingLink))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(unlinkSshAccess).toHaveBeenCalledWith({ selector: 'env-a', requestId: 'request-1' })
  })

  it('retries the recorded link rather than starting another', async () => {
    const { linkSshAccess, onChanged } = renderControl(environment(pendingLink))
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(linkSshAccess).toHaveBeenCalledWith({
      selector: 'env-a',
      requestId: 'request-1',
      sshTargetId: 'ssh-weknora',
      remotePort: 6768
    })
  })

  it('finishes an unfinished unlink by its own request id', async () => {
    const { unlinkSshAccess, onChanged } = renderControl(
      environment({ ...pendingLink, operation: 'unlink' })
    )
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(unlinkSshAccess).toHaveBeenCalledWith({ selector: 'env-a', requestId: 'request-1' })
  })
})
