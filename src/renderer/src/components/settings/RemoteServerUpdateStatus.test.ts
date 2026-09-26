import { describe, expect, it, vi } from 'vitest'
import type { RemoteServerUpdateEntry } from '@/runtime/remote-server-update-coordinator'
import { getRemoteServerManualUpdateHelp } from './RemoteServerUpdateStatus'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

const entry: RemoteServerUpdateEntry = {
  environmentId: 'server-1',
  name: 'Server',
  phase: 'manual',
  currentVersion: '1.4.0',
  targetVersion: null,
  progress: null,
  runtimeId: 'runtime-1',
  liveTabCount: 0,
  liveLeafCount: 0,
  support: null,
  error: null
}

describe('remote server manual update help', () => {
  it('does not promise that a manual update enables remote updates when the updater is unavailable', () => {
    expect(
      getRemoteServerManualUpdateHelp({
        ...entry,
        support: { installMode: 'interactive', automatic: false, reason: 'updater-unavailable' }
      })
    ).toBe('Remote updates are unavailable for this server. Update Orca on the server host.')
  })

  it('preserves the specific instructions for unsupported installs and development builds', () => {
    expect(
      getRemoteServerManualUpdateHelp({
        ...entry,
        support: {
          installMode: 'unsupported-headless-serve',
          automatic: false,
          reason: 'manual-service-update-required'
        }
      })
    ).toContain('service manager')
    expect(
      getRemoteServerManualUpdateHelp({
        ...entry,
        support: { installMode: 'interactive', automatic: false, reason: 'unpackaged-build' }
      })
    ).toContain('source checkout')
  })
})
