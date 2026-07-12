import type { GlobalSettings } from '../../../../shared/types'
import { mapWithConcurrency } from '../../../../shared/map-with-concurrency'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import {
  getRemoteRuntimePtyEnvironmentId,
  getRemoteRuntimeTerminalHandle
} from '@/runtime/runtime-terminal-stream'

type TerminalFitRestoreSettings = Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | undefined

// Why: "take back all terminals" can target a phone that controls hundreds of
// PTYs. Fanning out one IPC/RPC reclaim per PTY unbounded would burst the
// runtime transport; cap the in-flight reclaims so a huge session degrades to
// steady throughput instead of a thundering herd. Each reclaim is a short
// round-trip, so a modest pool keeps latency low without overwhelming it.
const RESTORE_FIT_CONCURRENCY = 8

const restoreFailedResult = (): { restored: boolean } => {
  // Why: terminal fit restore is best-effort when mobile/remote transports disappear.
  return { restored: false }
}

export async function restoreTerminalFitToDesktop(
  ptyId: string,
  settings: TerminalFitRestoreSettings
): Promise<boolean> {
  const remoteHandle = getRemoteRuntimeTerminalHandle(ptyId)
  const environmentId =
    getRemoteRuntimePtyEnvironmentId(ptyId) ?? settings?.activeRuntimeEnvironmentId ?? null
  const result =
    remoteHandle && environmentId
      ? await callRuntimeRpc<{ restored: boolean }>(
          { kind: 'environment', environmentId },
          'terminal.restoreFit',
          { terminal: remoteHandle },
          { timeoutMs: 15_000 }
        ).catch(restoreFailedResult)
      : await window.api.runtime.restoreTerminalFit(ptyId).catch(restoreFailedResult)

  return result.restored
}

export async function restoreTerminalFitsToDesktop(
  ptyIds: Iterable<string>,
  settings: TerminalFitRestoreSettings
): Promise<boolean> {
  const uniquePtyIds = [...new Set(ptyIds)]
  const results = await mapWithConcurrency(uniquePtyIds, RESTORE_FIT_CONCURRENCY, (ptyId) =>
    restoreTerminalFitToDesktop(ptyId, settings)
  )
  return results.some(Boolean)
}
