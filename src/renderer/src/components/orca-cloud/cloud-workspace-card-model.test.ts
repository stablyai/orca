import { describe, expect, it } from 'vitest'
import { translate } from '@/i18n/i18n'
import type { CloudSyncView } from '../../../../shared/cloud-sync/cloud-sync-contract'
import {
  cloudCardOnComputerStatus,
  cloudCardPrimary,
  cloudCardStateDetail,
  cloudCardUsageLine,
  mostUrgentAttention
} from './cloud-workspace-card-model'

const t = translate

function sync(choice: CloudSyncView['choice'], phase: CloudSyncView['phase'] = 'synced') {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the status reads only choice and phase
  return { choice, phase } as CloudSyncView
}

describe('calm cloud workspace card', () => {
  it('names the idle timer while running, the copy time while asleep', () => {
    const base = { restarting: false, idleSleepMinutes: 20, asOf: null }
    expect(cloudCardStateDetail({ ...base, state: 'running' }, t)).toBe('Sleeps in 20 min if idle')
    expect(
      cloudCardStateDetail({ ...base, state: 'running', idleSleepMinutes: undefined }, t)
    ).toBe('Sleeps in 15 min if idle')
    expect(cloudCardStateDetail({ ...base, state: 'sleeping' }, t)).toBeNull()
    expect(
      cloudCardStateDetail(
        { ...base, state: 'sleeping', asOf: new Date(2026, 0, 1, 14, 31).getTime() },
        t
      )
    ).toMatch(/^As of 2:31/)
  })

  it('reads memory against the plan, never the VM’s own total', () => {
    expect(cloudCardUsageLine({ cpuPercent: 13.4, memUsedBytes: 1.8e9 }, t)).toBe(
      'CPU 13% · Memory 1.8 / 16 GB'
    )
  })

  it('shows at most one attention row, the most urgent first, and none when all is well', () => {
    const secrets = { kind: 'secretsMissing' as const, count: 2 }
    const agent = { kind: 'agentNotSetUp' as const, agent: 'Claude', tabId: 't' }
    expect(mostUrgentAttention([null, null])).toBeNull()
    expect(mostUrgentAttention([secrets, agent])).toBe(agent)
    expect(mostUrgentAttention([secrets, null])).toBe(secrets)
  })

  it('sums up On this computer in a few words', () => {
    expect(cloudCardOnComputerStatus(null, t)).toBe('Off')
    expect(cloudCardOnComputerStatus(sync({ context: false, mirror: false }, 'off'), t)).toBe('Off')
    expect(cloudCardOnComputerStatus(sync({ context: true, mirror: false }), t)).toBe(
      '.context synced'
    )
    expect(cloudCardOnComputerStatus(sync({ context: true, mirror: true }), t)).toBe(
      'Mirroring · .context synced'
    )
    expect(cloudCardOnComputerStatus(sync({ context: true, mirror: true }, 'error'), t)).toBe(
      'Couldn’t sync'
    )
  })

  it('keeps one footer action per state; Restart only where it is the fix', () => {
    expect(cloudCardPrimary('running', false)).toBe('sleep')
    expect(cloudCardPrimary('sleeping', false)).toBe('wake')
    expect(cloudCardPrimary('archived', false)).toBe('unarchive')
    expect(cloudCardPrimary('unresponsive', false)).toBe('restart')
    expect(cloudCardPrimary('running', true)).toBe('restart')
    expect(cloudCardPrimary('waking', false)).toBeNull()
  })
})
