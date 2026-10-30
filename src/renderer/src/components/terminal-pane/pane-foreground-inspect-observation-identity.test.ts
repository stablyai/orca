/** Do not coalesce inspectProcess: each read commits a unique host observationEpoch, so a shared reply becomes replay for the second reader (#18419). Provider ratchet: src/main/providers/ssh-pty-inspect-observation-identity.test.ts. */
import { describe, expect, it } from 'vitest'
import { createPaneForegroundProcessReader } from './pane-foreground-process-reader'

const CONNECTION_ID = 'conn-1'
const RELAY_PTY_ID = 'pty-1'
const APP_PTY_ID = `ssh:${CONNECTION_ID}@@${RELAY_PTY_ID}`
const INCARNATION_ID = 'inc-1'

/** One host scan per request => one epoch per request. */
const hostObservation = (observationEpoch: number): unknown => ({
  foregroundProcess: 'claude',
  hasChildProcesses: true,
  foregroundProcessEvidence: {
    verdict: 'live',
    processName: 'claude',
    ptyId: RELAY_PTY_ID,
    ptyIncarnationId: INCARNATION_ID,
    authorityGeneration: 'gen-1',
    observationEpoch,
    capturedAgeMs: 0,
    fence: {
      platform: 'posix',
      shellPid: 100,
      shellStartTime: '1000',
      tty: '/dev/pts/3',
      foregroundPgid: 200
    }
  }
})

/** Holds every probe open so the tracker's supersede-and-reissue pair really overlaps. */
function createOverlappingReader(replies: { shared: boolean }): {
  readProcess: ReturnType<typeof createPaneForegroundProcessReader>
  settle: (index: number) => void
} {
  const resolvers: ((value: unknown) => void)[] = []
  return {
    // One reader instance per pane, exactly as the foreground tracker holds it.
    readProcess: createPaneForegroundProcessReader({
      readForegroundProcess: () => new Promise((resolve) => resolvers.push(resolve)) as never,
      isRemotePtyId: () => true,
      getExpectedIncarnationId: () => INCARNATION_ID
    }),
    // `shared` models what an in-flight dedupe would do: every joiner gets one host observation.
    settle: (index) => resolvers[index]?.(hostObservation(replies.shared ? 1 : index + 1))
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('pane foreground inspect observation identity', () => {
  it('keeps a reissued read `live` when it overlaps the probe it superseded', async () => {
    const { readProcess, settle } = createOverlappingReader({ shared: false })

    // Cancel bumps the generation without ending the probe; the reissued read overlaps it after the settle window.
    const superseded = readProcess(APP_PTY_ID, false)
    const reissued = readProcess(APP_PTY_ID, false)
    await flush()

    // The superseded read's continuation commits its epoch first.
    settle(0)
    expect((await superseded).remoteEvidenceVerdict).toBe('live')

    settle(1)
    const result = await reissued
    expect(result.remoteEvidenceVerdict).toBe('live')
    expect(result.processName).toBe('claude')
  })

  it('degrades the second overlapping read to `unverifiable` when one observation is shared', async () => {
    const { readProcess, settle } = createOverlappingReader({ shared: true })

    const superseded = readProcess(APP_PTY_ID, false)
    const reissued = readProcess(APP_PTY_ID, false)
    await flush()

    settle(0)
    expect((await superseded).remoteEvidenceVerdict).toBe('live')

    settle(1)
    const result = await reissued
    expect(result.remoteEvidenceVerdict).toBe('unverifiable')
    expect(result.processName).toBeNull()
  })
})
