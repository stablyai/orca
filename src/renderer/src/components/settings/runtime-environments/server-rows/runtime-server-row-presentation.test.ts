import { describe, expect, it } from 'vitest'
import type { RemoteServerUpdateEntry } from '../../../../../../shared/remote-runtime/host-updates/remote-server-update-coordinator'
import { getRuntimeServerProblemLine } from './runtime-server-row-meta'
import {
  getRuntimeServerVersionText,
  reconcileRemoteServerUpdateEntry
} from './runtime-server-row-presentation'

const t = (_key: string, fallback: string, values?: Record<string, unknown>): string =>
  fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(values?.[name] ?? ''))

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
    ...overrides
  }
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
  liveVersion: string | null,
  managedSummary: string | null = null
): string | null {
  const remoteUpdate = reconcileRemoteServerUpdateEntry(snapshot, liveVersion)
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
  return problem?.text ?? getRuntimeServerVersionText(remoteUpdate, liveVersion, t)
}

describe('reconcileRemoteServerUpdateEntry', () => {
  it('returns to the version line once the server reconnects on the target version', () => {
    expect(rowLine(entry({ phase: 'manual' }), '1.2.0')).toBe('Update Orca on the server host')
    expect(rowLine(entry({ phase: 'manual' }), '1.3.0')).toBe('v1.3.0')
    expect(reconcileRemoteServerUpdateEntry(entry({ phase: 'manual' }), '1.3.0')).toMatchObject({
      phase: 'current',
      currentVersion: '1.3.0',
      targetVersion: '1.3.0'
    })
  })

  it('shows the version after a deferred update later lands', () => {
    const snapshot = entry({ phase: 'manual' })
    // While deferred, the managed summary is the truth.
    expect(rowLine(snapshot, '1.2.0', 'Update to 1.3.0+abc deferred.')).toBe(
      'Update to 1.3.0+abc deferred.'
    )
    // Reloaded managed status drops the deferral once the host moved; the snapshot is stale too.
    expect(rowLine(snapshot, '1.3.0', null)).toBe('v1.3.0')
  })

  it('clears an update offer once the server reached the offered build', () => {
    const snapshot = entry({
      phase: 'available',
      targetVersion: '1.4.0',
      clientVersion: '1.3.0'
    })
    expect(reconcileRemoteServerUpdateEntry(snapshot, '1.4.0')?.phase).toBe('current')
  })

  it('falls back to this app version when the snapshot had no comparable target', () => {
    const snapshot = entry({
      phase: 'manual',
      currentVersion: 'unknown',
      targetVersion: null
    })
    expect(reconcileRemoteServerUpdateEntry(snapshot, '1.3.0')?.phase).toBe('current')
  })

  it('keeps a failure visible while the server is still short of the target', () => {
    const snapshot = entry({ phase: 'failed', error: 'Download failed' })
    expect(rowLine(snapshot, '1.2.0')).toBe('Update failed')
    // A different but still older build keeps the failure, with the fresh version recorded.
    const moved = reconcileRemoteServerUpdateEntry(snapshot, '1.2.5')
    expect(moved).toMatchObject({
      phase: 'failed',
      currentVersion: '1.2.5',
      error: 'Download failed'
    })
    expect(rowLine(snapshot, '1.2.5')).toBe('Update failed')
  })

  it('treats a failed attempt whose server did reach the target as finished', () => {
    expect(rowLine(entry({ phase: 'failed', error: 'Timed out' }), '1.3.0')).toBe('v1.3.0')
  })

  it('keeps a manual line while the server is still on an older build', () => {
    expect(rowLine(entry({ phase: 'manual' }), '1.2.5')).toBe('Update Orca on the server host')
  })

  it('leaves in-flight phases alone even when the restarted server already answered', () => {
    for (const phase of ['queued', 'checking-update', 'downloading', 'restarting'] as const) {
      const snapshot = entry({ phase })
      expect(reconcileRemoteServerUpdateEntry(snapshot, '1.3.0')).toBe(snapshot)
    }
    const checking = entry({ phase: 'checking', currentVersion: null })
    expect(reconcileRemoteServerUpdateEntry(checking, '1.3.0')).toBe(checking)
  })

  it('returns the same entry when the live version matches or is unknown', () => {
    const snapshot = entry({ phase: 'manual' })
    expect(reconcileRemoteServerUpdateEntry(snapshot, '1.2.0')).toBe(snapshot)
    expect(reconcileRemoteServerUpdateEntry(snapshot, null)).toBe(snapshot)
    expect(reconcileRemoteServerUpdateEntry(snapshot, '  ')).toBe(snapshot)
    expect(reconcileRemoteServerUpdateEntry(undefined, '1.3.0')).toBeUndefined()
  })
})
