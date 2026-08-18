import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ARTIFACT_CLI_MAX_RPC_BYTES } from '../../../../shared/artifacts'
import { publishArtifactFromSurface } from './artifact-publish-flow'

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

vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.callRuntimeRpc }))
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
  it('signs in before preparing and publishing the request', async () => {
    mocks.state.orcaProfileAuthStatus = { state: 'local' }
    mocks.connect.mockResolvedValue({ status: 'connected' })
    mocks.callRuntimeRpc.mockResolvedValue({ status: 'ok', value: published })
    const createRequest = vi.fn().mockResolvedValue(request)

    await expect(publishArtifactFromSurface(createRequest)).resolves.toBe(published)
    expect(mocks.connect).toHaveBeenCalledOnce()
    expect(createRequest).toHaveBeenCalledOnce()
    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'local' },
      'artifacts.publish',
      request
    )
  })

  it('resumes with fresh content after reconnecting', async () => {
    mocks.connect.mockResolvedValue({ status: 'connected' })
    mocks.callRuntimeRpc
      .mockResolvedValueOnce({ status: 'reconnect-required' })
      .mockResolvedValueOnce({ status: 'ok', value: published })
    const createRequest = vi
      .fn()
      .mockResolvedValueOnce(request)
      .mockResolvedValueOnce({ ...request, content: '<h1>Fresh</h1>' })

    await expect(publishArtifactFromSurface(createRequest)).resolves.toBe(published)
    expect(mocks.connect).toHaveBeenCalledOnce()
    expect(createRequest).toHaveBeenCalledTimes(2)
    expect(mocks.callRuntimeRpc.mock.calls[1]?.[2]).toMatchObject({
      content: '<h1>Fresh</h1>'
    })
  })

  it('surfaces sign-in failures without preparing the file', async () => {
    mocks.state.orcaProfileAuthStatus = { state: 'local' }
    mocks.connect.mockRejectedValue(new Error('login failed'))
    const createRequest = vi.fn().mockResolvedValue(request)

    await expect(publishArtifactFromSurface(createRequest)).resolves.toBeNull()
    expect(createRequest).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith('Could not share artifact', undefined)
  })

  it('rejects an oversized request before RPC', async () => {
    const createRequest = vi.fn().mockResolvedValue({
      ...request,
      content: '"'.repeat(Math.floor(ARTIFACT_CLI_MAX_RPC_BYTES / 2))
    })

    await expect(publishArtifactFromSurface(createRequest)).resolves.toBeNull()
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith('Could not share artifact', {
      description: 'Artifacts shared from Orca must be smaller than 800 KB.'
    })
  })

  it('shows confirmation without putting the public link in the toast', async () => {
    mocks.callRuntimeRpc.mockResolvedValue({ status: 'ok', value: published })
    await publishArtifactFromSurface(() => Promise.resolve(request))

    expect(mocks.toastSuccess).toHaveBeenCalledWith('Artifact shared')
  })
})
