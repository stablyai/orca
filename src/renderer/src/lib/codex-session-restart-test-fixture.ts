import type { RemoteForegroundEvidence } from '../../../shared/foreground-process-evidence'

export function liveRemoteEvidence(ptyId: string, processName = 'codex'): RemoteForegroundEvidence {
  return {
    authorityGeneration: 'runtime-authority',
    observationEpoch: 1,
    capturedAgeMs: 0,
    ptyId,
    ptyIncarnationId: 'incarnation-1',
    verdict: 'live',
    processName,
    fence: {
      platform: 'posix',
      shellPid: 1,
      shellStartTime: '1',
      tty: '/dev/pts/1',
      foregroundPgid: 1
    }
  }
}
