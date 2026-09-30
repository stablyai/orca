import { describe, expect, it } from 'vitest'
import type { WorkspacePortScanResult } from '../../../shared/workspace-ports'
import {
  getUnavailableWorkspacePortHosts,
  workspacePortHostForScanKey
} from './workspace-port-host-availability'

function scan(overrides: Partial<WorkspacePortScanResult> = {}): WorkspacePortScanResult {
  return { platform: 'linux', scannedAt: 1, ports: [], ...overrides }
}

describe('getUnavailableWorkspacePortHosts', () => {
  it('reports the failed host while another host still answers', () => {
    expect(
      getUnavailableWorkspacePortHosts({
        'local:all': scan(),
        'environment:env-1:all': scan({ unavailableReason: 'Remote connection dropped' })
      })
    ).toEqual([
      {
        scanKey: 'environment:env-1:all',
        host: { kind: 'environment', environmentId: 'env-1' },
        platform: 'linux',
        reason: 'Remote connection dropped'
      }
    ])
  })

  it('reports the local host as a local host ref, not an absent environment id', () => {
    expect(
      getUnavailableWorkspacePortHosts({
        'local:all': scan({ unavailableReason: 'lsof is unavailable' }),
        'environment:env-1:all': scan()
      })
    ).toEqual([
      {
        scanKey: 'local:all',
        host: { kind: 'local' },
        platform: 'linux',
        reason: 'lsof is unavailable'
      }
    ])
  })

  // Why: total loss of contact is where naming the host matters most — the merged
  // projection joins raw internal scan keys, so it cannot name them itself.
  it('names every host when all of them failed', () => {
    expect(
      getUnavailableWorkspacePortHosts({
        'local:all': scan({ unavailableReason: 'lsof is unavailable' }),
        'environment:env-1:all': scan({ unavailableReason: 'Remote connection dropped' })
      })
    ).toEqual([
      {
        scanKey: 'local:all',
        host: { kind: 'local' },
        platform: 'linux',
        reason: 'lsof is unavailable'
      },
      {
        scanKey: 'environment:env-1:all',
        host: { kind: 'environment', environmentId: 'env-1' },
        platform: 'linux',
        reason: 'Remote connection dropped'
      }
    ])
  })

  // Why: a paired web client's userAgent is not the Orca host's platform, so the
  // caller labels the local host from the scan's own platform.
  it("carries the failed scan's platform, and null when it is unknown", () => {
    expect(
      getUnavailableWorkspacePortHosts({
        'local:all': scan({ platform: 'win32', unavailableReason: 'netstat failed' }),
        'environment:env-1:all': scan({ platform: 'unknown', unavailableReason: 'dropped' })
      }).map((entry) => entry.platform)
    ).toEqual(['win32', null])
  })

  it('stays silent when nothing failed', () => {
    expect(getUnavailableWorkspacePortHosts({ 'local:all': scan() })).toEqual([])
    expect(getUnavailableWorkspacePortHosts({})).toEqual([])
  })
})

describe('workspacePortHostForScanKey', () => {
  it.each([
    ['local:all', { kind: 'local' }],
    ['environment:env-1:all', { kind: 'environment', environmentId: 'env-1' }],
    ['environment:weird:id:all', { kind: 'environment', environmentId: 'weird:id' }],
    ['all-hosts:all', { kind: 'unknown' }],
    ['environment::all', { kind: 'unknown' }],
    ['environment:env-1', { kind: 'unknown' }],
    ['local', { kind: 'unknown' }]
  ])('maps %s', (scanKey, expected) => {
    expect(workspacePortHostForScanKey(scanKey)).toEqual(expected)
  })
})
