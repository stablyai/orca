// ENV-ORIGIN-TOAST: a sandbox reaches origin through its GitHub credential, which the egress layer
// swaps in for a placeholder. Right after a create that can miss for a moment, and the doctor's
// `git ls-remote origin HEAD` says "Cannot reach remote". The workspace checks again before saying
// anything, and when it still can't reach GitHub the line has a Check again action.
import type { EnvironmentDoctorCheck } from '../../../../shared/environment-doctor-types'
import type { CloudSetupNotice } from '@/runtime/ephemeral-vm/ephemeral-vm-environment-check-triage'
import {
  getCloudSetupNoticesRecord,
  setCloudSetupNotices,
  type CloudSetupNoticesRecord
} from './cloud-setup-notices-store'

/** Waits before each confirming check: credentials usually land within seconds of the create. */
export const FETCH_CONFIRM_DELAYS_MS = [5_000, 15_000] as const

/** The sandbox's doctor (runVmEnvironmentCheck, passed in: it lives beside the create gate). */
export type CloudCheckRunner = (
  creationId: null,
  environmentId: string,
  path: string
) => Promise<{ checks: readonly EnvironmentDoctorCheck[] }>

async function fetchReachable(
  record: Pick<CloudSetupNoticesRecord, 'environmentId' | 'path'>,
  runCheck: CloudCheckRunner
): Promise<boolean | null> {
  const result = await runCheck(null, record.environmentId, record.path)
  const fetch = result.checks.find((check) => check.id === 'git.fetch')
  // No answer for git.fetch (orcad unreachable this time) proves nothing either way.
  return fetch ? fetch.status !== 'fail' : null
}

function withoutFetch(environmentId: string): void {
  const current = getCloudSetupNoticesRecord(environmentId)
  if (current) {
    setCloudSetupNotices({
      ...current,
      notices: current.notices.filter((notice) => notice.kind !== 'fetch')
    })
  }
}

/**
 * The create's check couldn't reach origin: check again after a short wait (twice), and only show
 * the line if it still can't. `record` is what the create published without the fetch line.
 */
export async function confirmCloudFetchFailure(
  record: CloudSetupNoticesRecord,
  notice: CloudSetupNotice,
  runCheck: CloudCheckRunner,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((done) => setTimeout(done, ms))
): Promise<'reachable' | 'unreachable'> {
  for (const delay of FETCH_CONFIRM_DELAYS_MS) {
    await sleep(delay)
    if ((await fetchReachable(record, runCheck)) === true) {
      return 'reachable'
    }
  }
  // Other lines may have been dismissed or changed meanwhile: add to what is there now.
  const current = getCloudSetupNoticesRecord(record.environmentId) ?? { ...record, notices: [] }
  setCloudSetupNotices({
    ...current,
    notices: [...current.notices.filter((other) => other.id !== notice.id), notice]
  })
  return 'unreachable'
}

/** Check again: drops the line when origin answers now. */
export async function recheckCloudFetch(
  environmentId: string,
  runCheck: CloudCheckRunner
): Promise<'reachable' | 'unreachable'> {
  const record = getCloudSetupNoticesRecord(environmentId)
  if (!record) {
    return 'reachable'
  }
  if ((await fetchReachable(record, runCheck)) === true) {
    withoutFetch(environmentId)
    return 'reachable'
  }
  return 'unreachable'
}
