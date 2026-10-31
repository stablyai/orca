import { afterEach, expect, it, vi } from 'vitest'
import { Session } from '../../src/main/daemon/session'
import { inspectTerminalHostProcess } from '../../src/main/daemon/terminal-host-process-inspection'
import type * as SnapshotReader from '../../src/shared/process-table-snapshot-reader'
import type { ProcessTableRow } from '../../src/shared/process-table-snapshot'
import { probePtyRunningWorkWithInspection } from '../../src/shared/pty-running-work-probe'

const { readSnapshot } = vi.hoisted(() => ({
  readSnapshot: vi.fn()
}))
vi.mock('../../src/shared/process-table-snapshot-reader', async (importOriginal) => ({
  ...(await importOriginal<typeof SnapshotReader>()),
  getStrictProcessTableSnapshotWithAge: readSnapshot
}))

afterEach(() => vi.restoreAllMocks())

it.each(['stopped', 'background', 'idle', 'unreadable'] as const)(
  'carries daemon child evidence through the real close guard for %s work',
  async (state) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const root: ProcessTableRow = {
      pid: 100,
      ppid: 1,
      pgid: 100,
      tpgid: 101,
      tty: 'ttys001',
      startTime: 'Thu Sep  3 16:02:01 2026',
      stat: 'Ss',
      command: 'login -fp user'
    }
    const rows = [root, { ...root, pid: 101, ppid: 100, pgid: 101, stat: 'S+', command: '-zsh' }]
    if (state === 'background' || state === 'stopped') {
      rows.push({
        ...root,
        pid: 102,
        ppid: 101,
        pgid: 102,
        stat: state === 'stopped' ? 'T' : 'S',
        command: 'vim draft.txt'
      })
    }
    if (state === 'unreadable') {
      readSnapshot.mockRejectedValue(new Error('unreadable'))
    } else {
      readSnapshot.mockResolvedValue({ rows, capturedAgeMs: 0 })
    }
    const session = new Session({
      sessionId: 'close-guard',
      cols: 80,
      rows: 24,
      scrollback: 10,
      shellReadySupported: false,
      subprocess: {
        pid: 100,
        processNameIsSpawnFile: true,
        getForegroundProcess: () => 'zsh',
        write() {},
        resize() {},
        kill() {},
        forceKill() {},
        signal() {},
        dispose() {},
        onData() {},
        onExit() {},
        terminateOwnedTree: () => 'unavailable'
      }
    })
    try {
      const [result] = await probePtyRunningWorkWithInspection(
        ['remote:owner:close-guard'],
        { timeoutMs: 1000 },
        () =>
          inspectTerminalHostProcess({
            sessionId: session.sessionId,
            session,
            authorityGeneration: 'owner',
            nextObservationEpoch: () => 1
          })
      )
      expect(result.verdict).toBe(
        state === 'idle' ? 'exited' : state === 'unreadable' ? 'unverifiable' : 'live'
      )
    } finally {
      session.dispose()
    }
  }
)
