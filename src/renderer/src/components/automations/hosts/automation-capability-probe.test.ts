import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getRuntimeEnvironmentStatus } from '@/runtime/rpc/compatibility/runtime-compatibility-probe'
import {
  AutomationHostScopeUnsupportedError,
  prepareAutomationLaunchSetup,
  resetAutomationCapabilityProbes
} from './automation-capability-probe'

vi.mock('@/runtime/rpc/compatibility/runtime-compatibility-probe', () => ({
  getRuntimeEnvironmentStatus: vi.fn()
}))

const HOST = { kind: 'runtime', environmentId: 'env-1', pairingRevision: 1 } as const
const BIWEEKLY = 'FREQ=WEEKLY;INTERVAL=2;BYDAY=WE;BYHOUR=11;BYMINUTE=0'

describe('prepareAutomationLaunchSetup schedule rules gate', () => {
  beforeEach(() => {
    resetAutomationCapabilityProbes()
    vi.mocked(getRuntimeEnvironmentStatus).mockReset()
  })

  it('refuses to write an interval rule to a host without the capability', async () => {
    vi.mocked(getRuntimeEnvironmentStatus).mockResolvedValue({
      capabilities: ['automations.surface.v1']
    } as never)
    await expect(prepareAutomationLaunchSetup(HOST, { rrule: BIWEEKLY })).rejects.toBeInstanceOf(
      AutomationHostScopeUnsupportedError
    )
  })

  it('writes it to a host with the capability, and to the desktop', async () => {
    vi.mocked(getRuntimeEnvironmentStatus).mockResolvedValue({
      capabilities: ['automations.schedule-rules.v1']
    } as never)
    await expect(prepareAutomationLaunchSetup(HOST, { rrule: BIWEEKLY })).resolves.toEqual({
      rrule: BIWEEKLY
    })
    await expect(
      prepareAutomationLaunchSetup({ kind: 'desktop' }, { rrule: BIWEEKLY })
    ).resolves.toEqual({ rrule: BIWEEKLY })
    expect(getRuntimeEnvironmentStatus).toHaveBeenCalledTimes(1)
  })
})
