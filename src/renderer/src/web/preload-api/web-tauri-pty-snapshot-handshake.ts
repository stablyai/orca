import type { PtyApi } from '../../../../preload/api/terminal/pty-api'
import type { RemoteRuntimeMultiplexedTerminalCallbacks } from '../../runtime/hosted-terminals/streams/remote-terminal-stream-contracts'

type SnapshotMeta = Parameters<RemoteRuntimeMultiplexedTerminalCallbacks['onSnapshot']>[1]
type SpawnResult = Awaited<ReturnType<PtyApi['spawn']>>
type InitialSnapshot = Pick<
  SpawnResult,
  | 'snapshot'
  | 'snapshotCols'
  | 'snapshotRows'
  | 'snapshotSeq'
  | 'snapshotKittyKeyboardFlags'
  | 'snapshotTerminalOwner'
  | 'isAlternateScreen'
  | 'pendingEscapeTailAnsi'
>
type SnapshotOutcome = { snapshot: InitialSnapshot } | { error: Error }

/** The first image belongs to the connect reply, before the pane installs its replay listener. */
export function createTauriPtySnapshotHandshake(timeoutMs = 15_000) {
  let settle: ((outcome: SnapshotOutcome) => void) | undefined
  let settled = false
  const outcome = new Promise<SnapshotOutcome>((resolve) => {
    settle = resolve
  })
  const timer = setTimeout(() => fail(new Error('terminal_initial_snapshot_timeout')), timeoutMs)

  function finish(value: SnapshotOutcome): boolean {
    if (settled) {
      return false
    }
    settled = true
    clearTimeout(timer)
    settle?.(value)
    return true
  }

  function fail(error: Error): void {
    finish({ error })
  }

  return {
    accept: (data: string, meta?: SnapshotMeta): boolean =>
      finish({
        snapshot: {
          snapshot: data,
          snapshotCols: meta?.cols,
          snapshotRows: meta?.rows,
          snapshotSeq: meta?.seq,
          snapshotKittyKeyboardFlags: meta?.kittyKeyboardFlags,
          snapshotTerminalOwner: meta?.terminalOwner,
          isAlternateScreen: meta?.alternateScreen,
          pendingEscapeTailAnsi: meta?.pendingEscapeTailAnsi
        }
      }),
    fail,
    wait: async (): Promise<InitialSnapshot> => {
      const result = await outcome
      if ('error' in result) {
        throw result.error
      }
      return result.snapshot
    }
  }
}
