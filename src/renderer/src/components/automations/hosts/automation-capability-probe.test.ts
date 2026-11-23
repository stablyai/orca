import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getRuntimeEnvironmentStatus } from '@/runtime/rpc/compatibility/runtime-compatibility-probe'
import type { RuntimeCapability } from '../../../../../shared/remote-runtime/protocol/protocol-version'
import type { RuntimeStatus } from '../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import {
  AutomationHostScopeUnsupportedError,
  prepareAutomationLaunchSetup,
  resetAutomationCapabilityProbes
} from './automation-capability-probe'

vi.mock('@/runtime/rpc/compatibility/runtime-compatibility-probe', () => ({
  getRuntimeEnvironmentStatus: vi.fn()
}))

const HOST = { kind: 'runtime', environmentId: 'env-1', pairingRevision: 1 } as const
const statusWith = (capabilities: RuntimeCapability[]): RuntimeStatus => ({
  runtimeId: 'rt-1',
  rendererGraphEpoch: 1,
  graphStatus: 'ready',
  authoritativeWindowId: null,
  liveTabCount: 0,
  liveLeafCount: 0,
  capabilities
})
const BIWEEKLY = 'FREQ=WEEKLY;INTERVAL=2;BYDAY=WE;BYHOUR=11;BYMINUTE=0'

describe('prepareAutomationLaunchSetup schedule rules gate', () => {
  beforeEach(() => {
    resetAutomationCapabilityProbes()
    vi.mocked(getRuntimeEnvironmentStatus).mockReset()
  })

  it('refuses to write an interval rule to a host without the capability', async () => {
    vi.mocked(getRuntimeEnvironmentStatus).mockResolvedValue(statusWith(['automations.surface.v1']))
    await expect(prepareAutomationLaunchSetup(HOST, { rrule: BIWEEKLY })).rejects.toBeInstanceOf(
      AutomationHostScopeUnsupportedError
    )
  })

  it('writes it to a host with the capability, and to the desktop', async () => {
    vi.mocked(getRuntimeEnvironmentStatus).mockResolvedValue(
      statusWith(['automations.schedule-rules.v1'])
    )
    await expect(prepareAutomationLaunchSetup(HOST, { rrule: BIWEEKLY })).resolves.toEqual({
      rrule: BIWEEKLY
    })
    await expect(
      prepareAutomationLaunchSetup({ kind: 'desktop' }, { rrule: BIWEEKLY })
    ).resolves.toEqual({ rrule: BIWEEKLY })
    expect(getRuntimeEnvironmentStatus).toHaveBeenCalledTimes(1)
  })

  it('re-probes on every save, so a host replaced in place cannot pass on an old answer', async () => {
    vi.mocked(getRuntimeEnvironmentStatus)
      .mockResolvedValueOnce(statusWith(['automations.schedule-rules.v1']))
      .mockResolvedValueOnce(statusWith([]))
    await prepareAutomationLaunchSetup(HOST, { rrule: BIWEEKLY })
    await expect(prepareAutomationLaunchSetup(HOST, { rrule: BIWEEKLY })).rejects.toBeInstanceOf(
      AutomationHostScopeUnsupportedError
    )
  })
})
