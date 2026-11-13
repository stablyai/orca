import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EnvironmentDoctorCheck } from '../../../../shared/environment-doctor-types'
import type { CloudSetupNotice } from '@/runtime/ephemeral-vm/ephemeral-vm-environment-check-triage'
import {
  FETCH_CONFIRM_DELAYS_MS,
  confirmCloudFetchFailure,
  recheckCloudFetch
} from './cloud-fetch-notice'
import {
  getCloudSetupNoticesRecord,
  resetCloudSetupNotices,
  setCloudSetupNotices,
  type CloudSetupNoticesRecord
} from './cloud-setup-notices-store'

function check(id: string, status: EnvironmentDoctorCheck['status']): EnvironmentDoctorCheck {
  return { id, category: 'git', status, message: id }
}

const fetchNotice: CloudSetupNotice = {
  id: 'git.fetch',
  kind: 'fetch',
  check: check('git.fetch', 'fail')
}
const pushNotice: CloudSetupNotice = {
  id: 'git.push',
  kind: 'push',
  check: check('git.push', 'fail')
}

function record(notices: readonly CloudSetupNotice[]): CloudSetupNoticesRecord {
  return {
    environmentId: 'env-1',
    path: '/w',
    repoId: 'repo-1',
    hostId: 'runtime:env-1',
    repoUrl: 'https://github.com/acme/api',
    notices
  }
}

function runner(...fetchStatuses: (EnvironmentDoctorCheck['status'] | null)[]) {
  return vi.fn(async () => {
    const status = fetchStatuses.length > 0 ? fetchStatuses.shift() : 'fail'
    return { checks: status ? [check('git.fetch', status)] : [] }
  })
}

const noWait = vi.fn(async () => {})

describe('ENV-ORIGIN-TOAST: "Cannot reach remote" only after a confirming check', () => {
  afterEach(() => {
    resetCloudSetupNotices()
    noWait.mockClear()
  })

  it('a sandbox that reaches GitHub a moment later never shows the line', async () => {
    setCloudSetupNotices(record([pushNotice]))
    const run = runner('pass')
    await expect(
      confirmCloudFetchFailure(record([pushNotice]), fetchNotice, run, noWait)
    ).resolves.toBe('reachable')
    expect(run).toHaveBeenCalledOnce()
    expect(noWait).toHaveBeenCalledWith(FETCH_CONFIRM_DELAYS_MS[0])
    expect(getCloudSetupNoticesRecord('env-1')?.notices.map((n) => n.kind)).toEqual(['push'])
  })

  it('still unreachable after every wait: the line joins what is shown now, with nothing lost', async () => {
    setCloudSetupNotices(record([pushNotice]))
    // A run with no git.fetch answer (orcad busy) proves nothing and doesn't end the wait early.
    const run = runner(null, 'fail')
    await expect(
      confirmCloudFetchFailure(record([pushNotice]), fetchNotice, run, noWait)
    ).resolves.toBe('unreachable')
    expect(run).toHaveBeenCalledTimes(FETCH_CONFIRM_DELAYS_MS.length)
    expect(getCloudSetupNoticesRecord('env-1')?.notices.map((n) => n.kind)).toEqual([
      'push',
      'fetch'
    ])
  })

  it('Check again drops the line once origin answers, and keeps it while it does not', async () => {
    setCloudSetupNotices(record([pushNotice, fetchNotice]))
    await expect(recheckCloudFetch('env-1', runner('fail'))).resolves.toBe('unreachable')
    expect(getCloudSetupNoticesRecord('env-1')?.notices).toHaveLength(2)
    await expect(recheckCloudFetch('env-1', runner('pass'))).resolves.toBe('reachable')
    expect(getCloudSetupNoticesRecord('env-1')?.notices.map((n) => n.kind)).toEqual(['push'])
  })
})
