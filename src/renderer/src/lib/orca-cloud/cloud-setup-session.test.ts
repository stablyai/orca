import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const selectOrcaProfileOrg = vi.hoisted(() => vi.fn(async () => undefined))
const storeState = vi.hoisted(() => ({
  orcaProfileAuthStatus: { cloud: { activeOrgId: undefined as string | undefined } },
  selectOrcaProfileOrg
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => storeState } }))

import type { CloudSetupSession } from '../../../../shared/orca-cloud-setup'
import {
  SETUP_FAST_POLL_MS,
  activeCloudSetupSessionId,
  getCloudSetupSnapshot,
  refreshCloudSetupSession,
  resetCloudSetupSessionsForTests,
  snapshotFromSession,
  startCloudSetupSession,
  subscribeCloudSetupSessions
} from './cloud-setup-session'

const ID = 'cs_AAAAAAAAAAAAAAAAAAAAAA'

function session(overrides: Partial<CloudSetupSession> = {}): CloudSetupSession {
  return {
    id: ID,
    steps: [
      { id: 'account', state: 'done' },
      { id: 'team', state: 'active' },
      { id: 'github', state: 'pending' }
    ],
    team: null,
    trial: null,
    plan: null,
    finished: false,
    error: null,
    expiresAt: Date.now() + 3600_000,
    ...overrides
  }
}

const cloudSetupStart = vi.fn()
const cloudSetupGet = vi.fn()

beforeEach(() => {
  vi.useFakeTimers()
  cloudSetupStart.mockReset()
  cloudSetupGet.mockReset()
  selectOrcaProfileOrg.mockClear()
  storeState.orcaProfileAuthStatus.cloud.activeOrgId = undefined
  vi.stubGlobal(
    'window',
    Object.assign(globalThis, { api: { orcaProfiles: { cloudSetupStart, cloudSetupGet } } })
  )
})

afterEach(() => {
  resetCloudSetupSessionsForTests()
  vi.useRealTimers()
})

describe('cloud setup session (renderer)', () => {
  it('maps a session to panel rows with the team name as detail', () => {
    const snapshot = snapshotFromSession(
      session({
        steps: [
          { id: 'account', state: 'done' },
          { id: 'team', state: 'done' },
          { id: 'plan', state: 'done', detail: 'trial' }
        ],
        team: { orgId: 'org_1', name: 'acme', created: true },
        finished: true
      })
    )
    expect(snapshot.steps).toEqual([
      { id: 'account', state: 'done' },
      { id: 'team', state: 'done', detail: 'acme' },
      { id: 'plan', state: 'done', detail: 'trial' }
    ])
    expect(snapshot.finished).toBe(true)
    expect(snapshot.error).toBeUndefined()
  })

  it('starts, polls every 2 s, follows the new team, and stops when finished', async () => {
    cloudSetupStart.mockResolvedValue({ status: 'opened', sessionId: ID, expiresAt: 0 })
    cloudSetupGet.mockResolvedValueOnce({ status: 'ok', session: session() })
    const seen: string[] = []
    subscribeCloudSetupSessions((id) => seen.push(id))

    expect(
      await startCloudSetupSession({ repo: 'https://github.com/acme/web', needs: ['github'] })
    ).toEqual({
      sessionId: ID
    })
    expect(cloudSetupStart).toHaveBeenCalledWith({
      repo: 'https://github.com/acme/web',
      needs: ['github']
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(getCloudSetupSnapshot(ID)?.steps[1]).toEqual({ id: 'team', state: 'active' })
    expect(activeCloudSetupSessionId()).toBe(ID)

    cloudSetupGet.mockResolvedValueOnce({
      status: 'ok',
      session: session({
        steps: [
          { id: 'account', state: 'done' },
          { id: 'team', state: 'done' },
          { id: 'github', state: 'done' }
        ],
        team: { orgId: 'org_new', name: 'acme', created: true },
        finished: true
      })
    })
    await vi.advanceTimersByTimeAsync(SETUP_FAST_POLL_MS)
    expect(selectOrcaProfileOrg).toHaveBeenCalledWith('org_new')
    expect(getCloudSetupSnapshot(ID)?.finished).toBe(true)
    expect(seen).toEqual([ID, ID])
    expect(activeCloudSetupSessionId()).toBeNull()

    // Finished: no more polls.
    await vi.advanceTimersByTimeAsync(SETUP_FAST_POLL_MS * 3)
    expect(cloudSetupGet).toHaveBeenCalledTimes(2)
  })

  it('stops on an expired session and returns null when setup cannot open', async () => {
    cloudSetupStart.mockResolvedValueOnce({ status: 'signed-out' })
    expect(await startCloudSetupSession({ needs: ['plan'] })).toBeNull()
    // A cancelled (or timed-out, or replaced) sign-in is not a failure: callers must not fall back
    // to another browser trip.
    cloudSetupStart.mockResolvedValueOnce({ status: 'cancelled' })
    expect(await startCloudSetupSession({ needs: ['plan'] })).toEqual({ cancelled: true })

    cloudSetupGet.mockResolvedValue({ status: 'not-found' })
    await refreshCloudSetupSession(ID)
    expect(getCloudSetupSnapshot(ID)).toBeNull()
    await vi.advanceTimersByTimeAsync(SETUP_FAST_POLL_MS * 2)
    expect(cloudSetupGet).toHaveBeenCalledTimes(1)
  })
})
