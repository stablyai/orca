import { inspectRuntimeTerminalProcess } from '@/runtime/runtime-terminal-inspection'
import {
  probePtyRunningWorkWithInspection,
  type PtyRunningWorkProbe
} from '../../../../shared/pty-running-work-probe'

export type {
  PtyRunningWorkProbe,
  PtyRunningWorkVerdict
} from '../../../../shared/pty-running-work-probe'

export function probePtyRunningWork(
  ptyIds: readonly string[],
  options: { timeoutMs: number }
): Promise<PtyRunningWorkProbe[]> {
  return probePtyRunningWorkWithInspection(ptyIds, options, (ptyId) =>
    // Close guards require host child-process evidence before acting.
    inspectRuntimeTerminalProcess(ptyId, { scanChildProcesses: true })
  )
}
