import { describe, expect, it, afterEach, vi } from 'vitest'
import { getSourceControlAiControllerDiscoveryHostKey } from './source-control/ai/use-ai'

describe('getSourceControlAiControllerDiscoveryHostKey', () => {
  it('keys generation settings by the active workspace connection', () => {
    const local = { kind: 'local' } as const

    expect(getSourceControlAiControllerDiscoveryHostKey(local, null)).toBe('local')
    expect(getSourceControlAiControllerDiscoveryHostKey(local, undefined)).toBe('unknown')
    expect(getSourceControlAiControllerDiscoveryHostKey(local, 'ssh-1')).toBe('ssh:ssh-1')
  })

  it('uses the repo owner runtime before SSH connection scope', () => {
    const owner = { kind: 'environment', environmentId: 'env-1' } as const

    expect(getSourceControlAiControllerDiscoveryHostKey(owner, 'ssh-1')).toBe('runtime:env-1')
  })
})

const { rejectAppStoreAccess } = vi.hoisted(() => ({
  rejectAppStoreAccess: vi.fn(() => {
    throw new Error('Pure helper tests must not access the app store')
  })
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(rejectAppStoreAccess, {
    getState: rejectAppStoreAccess,
    getInitialState: rejectAppStoreAccess,
    setState: rejectAppStoreAccess,
    subscribe: rejectAppStoreAccess
  })
}))

afterEach(() => {
  expect(rejectAppStoreAccess).not.toHaveBeenCalled()
})
