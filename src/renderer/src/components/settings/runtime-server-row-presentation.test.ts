import { describe, expect, it } from 'vitest'
import type { RemoteServerUpdateEntry } from '@/runtime/remote-server-update-coordinator'
import {
  getRuntimeServerStatusIndicator,
  getRuntimeServerVersionFooter
} from './runtime-server-row-presentation'

function updateEntry(patch: Partial<RemoteServerUpdateEntry>): RemoteServerUpdateEntry {
  return {
    environmentId: 'env-a',
    name: 'm4air',
    phase: 'offline',
    currentVersion: null,
    targetVersion: null,
    progress: null,
    runtimeId: null,
    liveTabCount: 0,
    liveLeafCount: 0,
    support: null,
    error: null,
    ...patch
  }
}

describe('runtime server status indicator', () => {
  it('names a revoked host as revoked, not disconnected', () => {
    expect(getRuntimeServerStatusIndicator('disconnected', true)).toEqual({
      label: 'Access revoked',
      labelClassName: 'text-destructive',
      dotClassName: 'bg-destructive'
    })
  })

  it('keeps the connection label otherwise', () => {
    expect(getRuntimeServerStatusIndicator('disconnected', false).label).toBe('Disconnected')
    expect(getRuntimeServerStatusIndicator('connected', false).label).toBe('Connected')
  })
})

describe('runtime server version footer', () => {
  it('shows the last verified version without the Offline badge when revoked', () => {
    expect(
      getRuntimeServerVersionFooter(updateEntry({}), {
        accessRevoked: true,
        lastKnownVersion: '1.4.229'
      })
    ).toEqual({ text: 'Orca v1.4.229 (last seen)', showUpdateStatus: false })
  })

  it('hides the footer when revoked and no version was ever verified', () => {
    expect(
      getRuntimeServerVersionFooter(updateEntry({}), {
        accessRevoked: true,
        lastKnownVersion: null
      })
    ).toBeNull()
  })

  it('keeps the offline footer for a host that is actually unreachable', () => {
    expect(
      getRuntimeServerVersionFooter(updateEntry({}), {
        accessRevoked: false,
        lastKnownVersion: '1.4.229'
      })
    ).toEqual({ text: 'Orca version unavailable', showUpdateStatus: true })
  })

  it('reports the live version and update status when the probe answered', () => {
    expect(
      getRuntimeServerVersionFooter(updateEntry({ phase: 'current', currentVersion: '1.5.0' }), {
        accessRevoked: true,
        lastKnownVersion: '1.4.229'
      })
    ).toEqual({ text: 'Orca v1.5.0', showUpdateStatus: true })
  })
})
