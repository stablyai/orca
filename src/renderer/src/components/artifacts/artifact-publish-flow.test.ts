import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ARTIFACT_MAX_CONTENT_BYTES } from '../../../../shared/artifacts'
import {
  ArtifactPublishPreparationError,
  publishArtifactFromSurface
} from './artifact-publish-flow'

const mocks = vi.hoisted(() => ({
  callRuntimeRpc: vi.fn(),
  connect: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  state: {
    orcaProfileAuthStatus: { state: 'connected' } as { state: string } | null,
    connectCurrentOrcaProfile: vi.fn()
  }
}))

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: mocks.callRuntimeRpc
}))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => mocks.state }
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock('sonner', () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess }
}))
const request = {
  sourceKey: '/repo/report.html',
  content: '<h1>Report</h1>',
  contentType: 'text/html' as const,
  fileName: 'report.html'
}
const published = {
  change: 'created' as const,
  item: {
    artifact: { slug: 'artifact-a' },
    shareUrl: 'https://share.onorca.dev/a/artifact-a'
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.state.orcaProfileAuthStatus = { state: 'connected' }
  mocks.state.connectCurrentOrcaProfile = mocks.connect
})

describe('artifact publish flow', () => {
  // Why: a re-read after sign-in could publish content the user never clicked Share on.
  it('publishes the clicked request again after reconnecting, without re-reading', async () => {
    mocks.connect.mockResolvedValue({ status: 'connected' })
    mocks.callRuntimeRpc
      .mockResolvedValueOnce({ status: 'reconnect-required' })
      .mockResolvedValueOnce({ status: 'ok', value: published })
    const createRequest = vi
      .fn()
      .mockResolvedValueOnce(request)
      .mockResolvedValueOnce({ ...request, content: '<h1>Later</h1>' })

    await expect(publishArtifactFromSurface(createRequest)).resolves.toBe(published)
    expect(mocks.connect).toHaveBeenCalledOnce()
    expect(createRequest).toHaveBeenCalledOnce()
    expect(mocks.callRuntimeRpc).toHaveBeenCalledTimes(2)
    expect(mocks.callRuntimeRpc.mock.calls[1]?.[2]).toBe(request)
  })

  it('surfaces sign-in failures without publishing', async () => {
    mocks.state.orcaProfileAuthStatus = { state: 'local' }
    mocks.connect.mockRejectedValue(new Error('login failed'))
    const createRequest = vi.fn().mockResolvedValue(request)

    await expect(publishArtifactFromSurface(createRequest)).resolves.toBeNull()
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith('Could not share artifact', undefined)
  })

  it('reports an unreadable file without asking the user to sign in', async () => {
    mocks.state.orcaProfileAuthStatus = { state: 'local' }
    const createRequest = vi
      .fn()
      .mockRejectedValue(new ArtifactPublishPreparationError('unreadable'))

    await expect(publishArtifactFromSurface(createRequest)).resolves.toBeNull()
    expect(mocks.connect).not.toHaveBeenCalled()
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('rejects an oversized request before RPC', async () => {
    const createRequest = vi.fn().mockResolvedValue({
      ...request,
      content: '"'.repeat(ARTIFACT_MAX_CONTENT_BYTES + 1)
    })

    await expect(publishArtifactFromSurface(createRequest)).resolves.toBeNull()
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith('Could not share artifact', {
      description: 'This artifact is too large to share.'
    })
  })
})
