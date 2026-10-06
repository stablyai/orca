import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { inspectRuntimeTerminalProcess } from '@/runtime/runtime-terminal-inspection'
import {
  probePtyRunningWorkWithInspection,
  type PtyRunningWorkProbe
} from '../../../../shared/pty-running-work-probe'

export type {
  PtyRunningWorkProbe,
  PtyRunningWorkVerdict
} from '../../../../shared/pty-running-work-probe'

type ProbeSettings = Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined

export function probePtyRunningWork(
  settings: ProbeSettings,
  ptyIds: readonly string[],
  options: { timeoutMs: number }
): Promise<PtyRunningWorkProbe[]> {
  return probePtyRunningWorkWithInspection(ptyIds, options, (ptyId) =>
    // Close guards require host child-process evidence before acting.
    inspectRuntimeTerminalProcess(settings, ptyId, { scanChildProcesses: true })
  )
}
