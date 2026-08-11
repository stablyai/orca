import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getPublishedArtifactLink } from './artifact-published-link-client'

const mocks = vi.hoisted(() => ({ callRuntimeRpc: vi.fn() }))

vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.callRuntimeRpc }))

beforeEach(() => {
  vi.clearAllMocks()
})

describe('published artifact link client', () => {
  it('returns the locally persisted public link', async () => {
    mocks.callRuntimeRpc.mockResolvedValue({
      status: 'ok',
      value: { shareUrl: 'https://share.onorca.dev/a/artifact-a' }
    })

    await expect(getPublishedArtifactLink('/repo/report.md')).resolves.toBe(
      'https://share.onorca.dev/a/artifact-a'
    )
    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'local' },
      'artifacts.getPublishedLink',
      { sourceKey: '/repo/report.md' }
    )
  })

  it('returns null when the source has not been shared', async () => {
    mocks.callRuntimeRpc.mockResolvedValue({ status: 'ok', value: null })
    await expect(getPublishedArtifactLink('/repo/report.md')).resolves.toBeNull()
  })

  it('rejects when the account must reconnect', async () => {
    mocks.callRuntimeRpc.mockResolvedValue({ status: 'reconnect-required' })
    await expect(getPublishedArtifactLink('/repo/report.md')).rejects.toThrow('reconnect-required')
  })
})
