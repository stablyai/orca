import { describe, expect, it } from 'vitest'
import type { RemoteServerUpdateEntry } from '../../../../../../shared/remote-runtime/host-updates/remote-server-update-coordinator'
import { getRuntimeServerProblemLine } from './runtime-server-row-meta'
import {
  getRuntimeServerVersionText,
  reconcileRemoteServerUpdateEntry,
  type RemoteServerLiveEvidence
} from './runtime-server-row-presentation'

const t = (_key: string, fallback: string, values?: Record<string, unknown>): string =>
  fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(values?.[name] ?? ''))

const RECORDED_AT = 1_000

function entry(overrides: Partial<RemoteServerUpdateEntry>): RemoteServerUpdateEntry {
  return {
    environmentId: 'env-test',
    name: 'Example server',
    phase: 'manual',
    currentVersion: '1.2.0',
    targetVersion: '1.3.0',
    progress: null,
    runtimeId: 'runtime-old',
    liveTabCount: 0,
    liveLeafCount: 0,
    support: null,
    error: null,
    managedOverSsh: true,
    clientVersion: '1.3.0',
    observedAt: RECORDED_AT,
    ...overrides
  }
}

/** A verified status checked after the entry was recorded. */
function fresh(appVersion: string | null): RemoteServerLiveEvidence {
  return { appVersion, checkedAt: RECORDED_AT + 1 }
}

/** A verified status checked before the entry was recorded. */
function older(appVersion: string): RemoteServerLiveEvidence {
  return { appVersion, checkedAt: RECORDED_AT - 1 }
}

const connectedRow = {
  accessRevoked: false,
  serverReplaced: false,
  problem: null,
  probeFailed: false,
  compatibilityBlocked: false
}

/** The row's second line: a problem line when one applies, else the version text. */
function rowLine(
  snapshot: RemoteServerUpdateEntry,
  live: RemoteServerLiveEvidence | null,
  managedSummary: string | null = null
): string | null {
  const remoteUpdate = reconcileRemoteServerUpdateEntry(snapshot, live)
  const problem = getRuntimeServerProblemLine(
    {
      environment: { lastUsedAt: null },
      row: connectedRow,
      remoteUpdate,
      managedStatusError: null,
      managedSummary,
      address: 'example.test:7000'
    },
    t
  )
  return problem?.text ?? getRuntimeServerVersionText(remoteUpdate, live?.appVersion, t)
}

describe('reconcileRemoteServerUpdateEntry', () => {
  it('returns to the version line once the server reconnects on the target version', () => {
    expect(rowLine(entry({ phase: 'manual' }), fresh('1.2.0'))).toBe(
      'Update Orca on the server host'
    )
    expect(rowLine(entry({ phase: 'manual' }), fresh('1.3.0'))).toBe('v1.3.0')
    expect(
      reconcileRemoteServerUpdateEntry(entry({ phase: 'manual' }), fresh('1.3.0'))
    ).toMatchObject({ phase: 'current', currentVersion: '1.3.0', targetVersion: '1.3.0' })
  })

  it('shows the version after a deferred update later lands', () => {
    const snapshot = entry({ phase: 'manual' })
    // While deferred, the managed summary is the truth.
    expect(rowLine(snapshot, fresh('1.2.0'), 'Update to 1.3.0+abc deferred.')).toBe(
      'Update to 1.3.0+abc deferred.'
    )
    // Reloaded managed status drops the deferral once the host moved; the snapshot is stale too.
    expect(rowLine(snapshot, fresh('1.3.0'), null)).toBe('v1.3.0')
  })

  it('clears an update offer once the server reached the offered build', () => {
    const snapshot = entry({ phase: 'available', targetVersion: '1.4.0', clientVersion: '1.3.0' })
    expect(reconcileRemoteServerUpdateEntry(snapshot, fresh('1.4.0'))?.phase).toBe('current')
  })

  it('keeps a failure visible while the server is still short of the target', () => {
    const snapshot = entry({ phase: 'failed', error: 'Download failed' })
    expect(rowLine(snapshot, fresh('1.2.0'))).toBe('Update failed')
    // A different but still older build keeps the failure, with the fresh version recorded.
    expect(reconcileRemoteServerUpdateEntry(snapshot, fresh('1.2.5'))).toMatchObject({
      phase: 'failed',
      currentVersion: '1.2.5',
      error: 'Download failed'
    })
    expect(rowLine(snapshot, fresh('1.2.5'))).toBe('Update failed')
  })

  it('treats a failed attempt whose server did reach the target as finished', () => {
    expect(rowLine(entry({ phase: 'failed', error: 'Timed out' }), fresh('1.3.0'))).toBe('v1.3.0')
  })

  it('keeps a failed entry whose host still reports the same version', () => {
    const snapshot = entry({ phase: 'failed', currentVersion: '1.3.0', error: 'Timed out' })
    expect(reconcileRemoteServerUpdateEntry(snapshot, fresh('1.3.0'))).toBe(snapshot)
  })

  it('keeps a manual line while the server is still on an older build', () => {
    expect(rowLine(entry({ phase: 'manual' }), fresh('1.2.5'))).toBe(
      'Update Orca on the server host'
    )
  })

  it('leaves in-flight phases alone even when the restarted server already answered', () => {
    for (const phase of ['queued', 'checking-update', 'downloading', 'restarting'] as const) {
      const snapshot = entry({ phase })
      expect(reconcileRemoteServerUpdateEntry(snapshot, fresh('1.3.0'))).toBe(snapshot)
    }
    const checking = entry({ phase: 'checking', currentVersion: null })
    expect(reconcileRemoteServerUpdateEntry(checking, fresh('1.3.0'))).toBe(checking)
  })

  it('returns the same entry when there is no usable live version', () => {
    const snapshot = entry({ phase: 'manual' })
    expect(reconcileRemoteServerUpdateEntry(snapshot, fresh('1.2.0'))).toBe(snapshot)
    expect(reconcileRemoteServerUpdateEntry(snapshot, fresh(null))).toBe(snapshot)
    expect(reconcileRemoteServerUpdateEntry(snapshot, fresh('  '))).toBe(snapshot)
    expect(reconcileRemoteServerUpdateEntry(snapshot, null)).toBe(snapshot)
    expect(reconcileRemoteServerUpdateEntry(undefined, fresh('1.3.0'))).toBeUndefined()
  })

  describe('evidence ordering (RS-03)', () => {
    it('keeps a newer failure against an older at-target status, then clears on a fresh one', () => {
      const failure = entry({ phase: 'failed', error: 'Download failed', runtimeId: 'runtime-new' })
      // Retained from the replaced runtime, checked before this failure was recorded.
      expect(rowLine(failure, older('1.3.0'))).toBe('Update failed')
      expect(reconcileRemoteServerUpdateEntry(failure, older('1.3.0'))).toBe(failure)
      // A verified answer checked after the failure establishes recovery.
      expect(rowLine(failure, fresh('1.3.0'))).toBe('v1.3.0')
    })

    it('ignores a status checked at the same moment the entry was recorded', () => {
      const failure = entry({ phase: 'failed' })
      expect(
        reconcileRemoteServerUpdateEntry(failure, { appVersion: '1.3.0', checkedAt: RECORDED_AT })
      ).toBe(failure)
    })

    it('needs to know when the entry was recorded', () => {
      const unstamped = entry({ phase: 'failed', observedAt: undefined })
      expect(reconcileRemoteServerUpdateEntry(unstamped, fresh('1.3.0'))).toBe(unstamped)
    })
  })

  describe('version regressions (RS-04)', () => {
    const updated = entry({ phase: 'updated', currentVersion: '1.3.0' })

    it('keeps the updated version against a lagging status', () => {
      expect(reconcileRemoteServerUpdateEntry(updated, older('1.2.0'))).toBe(updated)
      expect(rowLine(updated, older('1.2.0'))).toBe('v1.3.0')
    })

    it('keeps the updated version against an unparsable status', () => {
      expect(reconcileRemoteServerUpdateEntry(updated, fresh('not-a-version'))).toBe(updated)
      expect(reconcileRemoteServerUpdateEntry(updated, fresh('0.0.0-dev+'))).toBe(updated)
    })

    it('records a genuine rollback observed after the update', () => {
      expect(reconcileRemoteServerUpdateEntry(updated, fresh('1.2.0'))).toMatchObject({
        phase: 'updated',
        currentVersion: '1.2.0'
      })
    })
  })

  describe('update targets (RS-05)', () => {
    it('falls back to this app version only when the target is missing', () => {
      const missing = entry({ phase: 'manual', currentVersion: 'unknown', targetVersion: null })
      expect(reconcileRemoteServerUpdateEntry(missing, fresh('1.3.0'))?.phase).toBe('current')
      const noClient = entry({ phase: 'manual', targetVersion: null, clientVersion: null })
      expect(reconcileRemoteServerUpdateEntry(noClient, fresh('1.3.0'))?.phase).toBe('manual')
    })

    it('keeps the update state when the offer is blank or malformed', () => {
      for (const targetVersion of ['', '  ', 'latest']) {
        const offer = entry({ phase: 'available', targetVersion })
        expect(reconcileRemoteServerUpdateEntry(offer, fresh('1.3.0'))).toMatchObject({
          phase: 'available',
          currentVersion: '1.3.0',
          targetVersion
        })
      }
    })

    it('compares against a valid offer', () => {
      const offer = entry({ phase: 'available', targetVersion: '1.4.0' })
      expect(reconcileRemoteServerUpdateEntry(offer, fresh('1.3.0'))?.phase).toBe('available')
      expect(reconcileRemoteServerUpdateEntry(offer, fresh('1.4.0'))?.phase).toBe('current')
    })
  })
})
