import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({
  createTab: vi.fn(() => ({ id: 'tab-1' })),
  setTabCustomTitle: vi.fn()
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

import { runEnvironmentSetup } from './cloud-environment-held'
import {
  getCloudSetupNoticesRecord,
  resetCloudSetupNotices,
  setCloudSetupNotices,
  visibleCloudSetupNotices,
  type CloudSetupNoticesRecord
} from './cloud-setup-notices-store'

const get = vi.fn()
const record: CloudSetupNoticesRecord = {
  environmentId: 'rt-env',
  path: '/w',
  repoId: 'r',
  hostId: null,
  repoUrl: 'https://github.com/acme/web',
  notices: [
    {
      id: 'environment.held',
      kind: 'environmentHeld',
      environmentId: 'env_0123abcd',
      check: { id: 'environment.held', category: 'setup', status: 'warn', message: 'held' }
    }
  ]
}

describe('Run setup now (ENV-BUILD-CHURN)', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { api: { orcaCloudEnvironments: { get } } }
    })
    setCloudSetupNotices(record)
  })
  afterEach(() => {
    resetCloudSetupNotices()
    vi.clearAllMocks()
  })

  it("runs the environment's install script in a Setup terminal and drops the line", async () => {
    get.mockResolvedValue({ ok: true, data: { environment: { installScript: 'pnpm install' } } })
    await runEnvironmentSetup('w1', record, 'environment.held')
    expect(get).toHaveBeenCalledWith('env_0123abcd')
    expect(store.createTab).toHaveBeenCalledWith('w1', undefined, undefined, {
      pendingStartup: { command: 'pnpm install' }
    })
    expect(
      visibleCloudSetupNotices(
        {
          records: { 'rt-env': getCloudSetupNoticesRecord('rt-env')! },
          dismissed: new Set(['rt-env\0environment.held'])
        },
        'rt-env'
      )
    ).toEqual([])
  })

  it('an unreadable environment keeps the line and says so', async () => {
    get.mockResolvedValue({ ok: false, error: { code: 'unavailable', message: 'x' } })
    await runEnvironmentSetup('w1', record, 'environment.held')
    expect(store.createTab).not.toHaveBeenCalled()
  })
})
