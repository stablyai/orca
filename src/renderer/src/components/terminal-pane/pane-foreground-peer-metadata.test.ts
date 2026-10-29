import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PaneForegroundAgentEntry } from '@/store/slices/pane-foreground-agent'
import type {
  ClaudePeerIdentity,
  HostProcessInspection
} from '../../../../shared/terminal-process-inspection'
import { createPaneForegroundAgentTracker } from './pane-foreground-agent-tracker'

const PEER = { agentName: 'main-fc', agentPid: 200, permissionMode: 'plan' }

function remoteInspection(
  observationEpoch: number,
  peer: ClaudePeerIdentity = {},
  options: { incarnationId?: string; capturedAgeMs?: number; processName?: string } = {}
): HostProcessInspection {
  const processName = options.processName ?? 'claude'
  return {
    foregroundProcess: processName,
    hasChildProcesses: true,
    ...peer,
    foregroundProcessEvidence: {
      verdict: 'live',
      processName,
      ptyId: 'pty-1',
      ptyIncarnationId: options.incarnationId ?? 'inc-1',
      authorityGeneration: 'host-1',
      observationEpoch,
      capturedAgeMs: options.capturedAgeMs ?? 0,
      fence: {
        platform: 'posix',
        shellPid: 100,
        shellStartTime: '1000',
        tty: '/dev/pts/3',
        foregroundPgid: 200,
        process: { pid: 200, startTime: '1001' }
      }
    }
  }
}

function trackRemote(read: () => Promise<HostProcessInspection>) {
  let published: PaneForegroundAgentEntry | undefined
  const publish = vi.fn((entry: PaneForegroundAgentEntry) => {
    published = entry
  })
  const tracker = createPaneForegroundAgentTracker({
    getPtyId: () => 'ssh:conn-1@@pty-1',
    isTrackablePtyId: () => true,
    isRemotePtyId: () => true,
    getExpectedIncarnationId: () => 'inc-1',
    readForegroundProcess: read,
    confirmForegroundProcess: read,
    getPublishedEntry: () => published,
    publish
  })
  return { tracker, publish, entry: () => published }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('remote pane peer metadata', () => {
  it('publishes the peer on the first existing SSH foreground read without starting a poll', async () => {
    const read = vi.fn(async () => remoteInspection(1, PEER))
    const { tracker, entry } = trackRemote(read)
    tracker.onVisiblePtyBound()
    await vi.advanceTimersByTimeAsync(350)
    expect(entry()).toMatchObject({ agent: 'claude', ...PEER })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(read).toHaveBeenCalledExactlyOnceWith('ssh:conn-1@@pty-1', {
      expectedIncarnationId: 'inc-1'
    })
    tracker.dispose()
  })

  it('replaces and clears an old peer using later admitted foreground responses', async () => {
    const read = vi
      .fn<() => Promise<HostProcessInspection>>()
      .mockResolvedValueOnce(remoteInspection(1, PEER))
      .mockResolvedValueOnce(
        remoteInspection(2, { ...PEER, agentName: 'renamed-peer', permissionMode: 'default' })
      )
      .mockResolvedValueOnce(remoteInspection(3))
    const { tracker, entry } = trackRemote(read)
    for (const name of ['main-fc', 'renamed-peer', undefined]) {
      tracker.onVisiblePtyBound()
      await vi.advanceTimersByTimeAsync(350)
      expect(entry()?.agentName).toBe(name)
    }
    expect(entry()?.agentPid).toBeUndefined()
    expect(entry()?.permissionMode).toBeUndefined()
    tracker.dispose()
  })

  it.each([{ incarnationId: 'retired-incarnation' }, { capturedAgeMs: 2_001 }])(
    'withholds peer metadata from rejected host evidence: %j',
    async (options) => {
      const { tracker, publish } = trackRemote(async () => remoteInspection(1, PEER, options))
      tracker.onVisiblePtyBound()
      await vi.advanceTimersByTimeAsync(350)
      expect(publish).not.toHaveBeenCalled()
      tracker.dispose()
    }
  )

  it('does not let a replayed response replace the current peer', async () => {
    const read = vi
      .fn<() => Promise<HostProcessInspection>>()
      .mockResolvedValueOnce(remoteInspection(2, PEER))
      .mockResolvedValueOnce(remoteInspection(1, { ...PEER, agentName: 'stale-peer' }))
    const { tracker, entry } = trackRemote(read)
    tracker.onVisiblePtyBound()
    await vi.advanceTimersByTimeAsync(350)
    expect(entry()?.agentName).toBe('main-fc')
    tracker.onVisiblePtyBound()
    await vi.advanceTimersByTimeAsync(350)
    expect(entry()?.agentName).toBe('main-fc')
    tracker.dispose()
  })

  it('drops the peer when the same pane switches to another agent', async () => {
    const read = vi
      .fn<() => Promise<HostProcessInspection>>()
      .mockResolvedValueOnce(remoteInspection(1, PEER))
      .mockResolvedValueOnce(remoteInspection(2, PEER, { processName: 'codex' }))
    const { tracker, entry } = trackRemote(read)
    tracker.onVisiblePtyBound()
    await vi.advanceTimersByTimeAsync(350)
    expect(entry()?.agentName).toBe('main-fc')
    tracker.onVisiblePtyBound()
    await vi.advanceTimersByTimeAsync(350)
    expect(entry()?.agent).toBe('codex')
    expect(entry()?.agentName).toBeUndefined()
    tracker.dispose()
  })
})
