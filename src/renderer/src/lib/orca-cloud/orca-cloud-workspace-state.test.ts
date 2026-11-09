import { describe, expect, it } from 'vitest'
import type { CloudWakeProgressEvent } from '../../../../shared/hosted-sandbox/cloud-workspace-api'
import type { HostedWorkspaceStatus } from '../../../../shared/hosted-sandbox/hosted-sandbox-wire'
import {
  buildFileTree,
  deriveCloudDotState,
  formatBytes,
  formatCents,
  formatDuration,
  formatHours,
  percentOf,
  visibleOom,
  wakeElapsedSeconds
} from './orca-cloud-workspace-state'

const NOW = 1_800_000_000_000
const status = (state: HostedWorkspaceStatus['state'], archive: HostedWorkspaceStatus['archive'] = null): HostedWorkspaceStatus => ({
  state,
  metrics: null,
  uptimeMs: null,
  usage: { totalMs: 0, centsPerHour: 75, costCents: 0 },
  archive,
  checkedAt: NOW
})
const wake = (phase: CloudWakeProgressEvent['phase'], at = NOW): CloudWakeProgressEvent => ({
  workspaceId: 'w',
  phase,
  source: 'open',
  startedAt: at - 1000,
  at
})

describe('deriveCloudDotState', () => {
  it('shows an in-flight wake over everything, including a sleeping desktop record', () => {
    expect(deriveCloudDotState({ status: status('sleeping'), wake: wake('waking'), sleeping: true, now: NOW })).toBe('waking')
    expect(deriveCloudDotState({ status: status('ready'), wake: wake('connecting'), sleeping: false, now: NOW })).toBe('waking')
  })

  it('treats a wake with no terminal event for 4 minutes as stale', () => {
    expect(
      deriveCloudDotState({ status: status('ready'), wake: wake('waking', NOW - 5 * 60_000), sleeping: false, now: NOW })
    ).toBe('running')
  })

  it('archived beats the desktop sleep state; failed wakes show until stale', () => {
    expect(deriveCloudDotState({ status: status('archived'), wake: undefined, sleeping: true, now: NOW })).toBe('archived')
    expect(
      deriveCloudDotState({
        status: status('sleeping', { archivedAt: NOW, expiresAt: null }),
        wake: undefined,
        sleeping: true,
        now: NOW
      })
    ).toBe('archived')
    expect(deriveCloudDotState({ status: status('sleeping'), wake: wake('failed'), sleeping: true, now: NOW })).toBe('failed')
  })

  it('maps control-plane states; the local sleep record only fills in before the first read', () => {
    expect(deriveCloudDotState({ status: status('ready'), wake: undefined, sleeping: false, now: NOW })).toBe('running')
    expect(deriveCloudDotState({ status: status('unresponsive'), wake: undefined, sleeping: false, now: NOW })).toBe('unresponsive')
    expect(deriveCloudDotState({ status: status('ready'), wake: undefined, sleeping: true, now: NOW })).toBe('running')
    expect(deriveCloudDotState({ status: null, wake: undefined, sleeping: true, now: NOW })).toBe('sleeping')
    expect(deriveCloudDotState({ status: status('provisioning'), wake: undefined, sleeping: false, now: NOW })).toBe('waking')
    expect(deriveCloudDotState({ status: null, wake: undefined, sleeping: false, now: NOW })).toBe('unknown')
  })
})

describe('visibleOom', () => {
  it('hides kills the user dismissed and shows newer ones', () => {
    const oom = { workspaceId: 'w', oomKills: 2, victim: 'node', at: NOW }
    expect(visibleOom(oom, undefined)).toBe(oom)
    expect(visibleOom(oom, 2)).toBeNull()
    expect(visibleOom({ ...oom, oomKills: 3 }, 2)).not.toBeNull()
    expect(visibleOom(undefined, undefined)).toBeNull()
  })
})

describe('formatters', () => {
  it('formats bytes, durations, hours, cents and percents', () => {
    expect(formatBytes(2e9)).toBe('2.0 GB')
    expect(formatBytes(34_292_629_504)).toBe('34 GB')
    expect(formatBytes(512e6)).toBe('512 MB')
    expect(formatDuration(45_000)).toBe('45s')
    expect(formatDuration(12 * 60_000)).toBe('12m')
    expect(formatDuration(3 * 3_600_000 + 5 * 60_000)).toBe('3h 05m')
    expect(formatDuration(52 * 3_600_000)).toBe('2d 4h')
    expect(formatHours(90 * 60_000)).toBe('1.5 h')
    expect(formatHours(140 * 3_600_000)).toBe('140 h')
    expect(formatCents(113)).toBe('$1.13')
    expect(percentOf(2, 8)).toBe(25)
    expect(percentOf(1, 0)).toBe(0)
    expect(wakeElapsedSeconds(NOW - 3_400, NOW)).toBe(3)
  })
})

describe('buildFileTree', () => {
  it('nests paths with directories first, alphabetically', () => {
    const tree = buildFileTree(['src/b.ts', 'README.md', 'src/a/x.ts', 'package.json'])
    expect(tree.map((n) => n.name)).toEqual(['src', 'package.json', 'README.md'])
    expect(tree[0]!.children.map((n) => n.name)).toEqual(['a', 'b.ts'])
    expect(tree[0]!.children[0]!.children[0]!.path).toBe('src/a/x.ts')
  })
})
