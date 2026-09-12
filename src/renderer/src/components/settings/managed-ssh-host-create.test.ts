// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  list: vi.fn(),
  listTargets: vi.fn(),
  addTarget: vi.fn(),
  recordSshRepoReadoptions: vi.fn(),
  setSshTargetsMetadata: vi.fn(),
  setRuntimeEnvironments: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  error: vi.fn()
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks } }))
vi.mock('sonner', () => ({ toast: mocks }))
import { createManagedSshHost } from './managed-ssh-host-create'

const target = { label: 'Builder', host: 'builder', port: 22, username: 'dev' }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.create.mockReset().mockResolvedValue({
    requestId: 'request-1',
    sshTargetId: 'ssh-1',
    repoReadoptions: [],
    result: { outcome: 'created', environment: { id: 'environment-1' } }
  })
  mocks.list.mockReset().mockResolvedValue([{ id: 'environment-1' }])
  mocks.listTargets.mockReset().mockResolvedValue([])
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      runtimeEnvironments: { createOrcadSshHost: mocks.create, list: mocks.list },
      ssh: { listTargets: mocks.listTargets, addTarget: mocks.addTarget }
    }
  })
})

describe('SSH form managed provisioning', () => {
  it('uses the supplied retry identity and refreshes the runtime catalog', async () => {
    await createManagedSshHost('request-1', target)
    expect(mocks.create).toHaveBeenCalledWith({ requestId: 'request-1', name: 'Builder', target })
    expect(mocks.setRuntimeEnvironments).toHaveBeenCalledWith([{ id: 'environment-1' }])
    expect(mocks.setSshTargetsMetadata).toHaveBeenCalledWith([])
    expect(mocks.success).toHaveBeenCalledOnce()
    expect(mocks.addTarget).not.toHaveBeenCalled()
  })

  it.each(['pending', 'deferred'])('does not report %s setup as ready', async (outcome) => {
    mocks.create.mockResolvedValue({
      repoReadoptions: [],
      result: { outcome, reason: 'unverifiable' }
    })
    await createManagedSshHost('request-1', target)
    expect(mocks.success).not.toHaveBeenCalled()
    expect(mocks.info).toHaveBeenCalledWith(expect.stringContaining('pending'), {
      description: 'unverifiable'
    })
    expect(mocks.list).toHaveBeenCalledOnce()
    expect(mocks.addTarget).not.toHaveBeenCalled()
  })

  it('keeps a completed request completed when catalog refresh fails', async () => {
    mocks.list.mockRejectedValue(new Error('transport unavailable'))
    await expect(createManagedSshHost('request-1', target)).resolves.toBeUndefined()
    expect(mocks.error).toHaveBeenCalledWith(expect.stringContaining('refresh'))
    expect(mocks.create).toHaveBeenCalledOnce()
  })

  it('requires the updated preload instead of falling back to a relay', async () => {
    delete (window.api.runtimeEnvironments as Partial<typeof window.api.runtimeEnvironments>)
      .createOrcadSshHost
    await expect(createManagedSshHost('request-1', target)).rejects.toThrow('Restart Orca')
    expect(mocks.addTarget).not.toHaveBeenCalled()
  })
})
