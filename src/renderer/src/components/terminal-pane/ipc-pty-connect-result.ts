import { isTuiAgent } from '../../../../shared/tui-agent-config'
import type { PtyConnectResult } from './pty-transport-types'

type IpcPtySpawnResult = PtyConnectResult & { isReattach?: boolean }

export function projectIpcPtyConnectResult(
  spawnResult: IpcPtySpawnResult
): string | PtyConnectResult {
  const launchAgent = isTuiAgent(spawnResult.launchAgent) ? spawnResult.launchAgent : undefined
  if (spawnResult.isReattach || spawnResult.coldRestore || spawnResult.sessionExpired) {
    return {
      id: spawnResult.id,
      ...(spawnResult.isReattach ? { isReattach: true } : {}),
      ...(launchAgent ? { launchAgent } : {}),
      ...(spawnResult.launchConfig ? { launchConfig: spawnResult.launchConfig } : {}),
      snapshot: spawnResult.snapshot,
      snapshotCols: spawnResult.snapshotCols,
      snapshotRows: spawnResult.snapshotRows,
      ...(spawnResult.snapshotPrefixAnsi !== undefined
        ? { snapshotPrefixAnsi: spawnResult.snapshotPrefixAnsi }
        : {}),
      ...(spawnResult.snapshotFrameAnsi !== undefined
        ? { snapshotFrameAnsi: spawnResult.snapshotFrameAnsi }
        : {}),
      ...(spawnResult.snapshotFrameRestoreAnsi !== undefined
        ? { snapshotFrameRestoreAnsi: spawnResult.snapshotFrameRestoreAnsi }
        : {}),
      isAlternateScreen: spawnResult.isAlternateScreen,
      sessionExpired: spawnResult.sessionExpired,
      coldRestore: spawnResult.coldRestore,
      replay: spawnResult.replay,
      pendingEscapeTailAnsi: spawnResult.pendingEscapeTailAnsi,
      ...(spawnResult.agentResumeUnavailable ? { agentResumeUnavailable: true as const } : {})
    }
  }
  if (
    launchAgent ||
    spawnResult.launchConfig ||
    spawnResult.startupCwdFallback ||
    spawnResult.agentResumeUnavailable
  ) {
    return {
      id: spawnResult.id,
      ...(launchAgent ? { launchAgent } : {}),
      ...(spawnResult.launchConfig ? { launchConfig: spawnResult.launchConfig } : {}),
      ...(spawnResult.startupCwdFallback
        ? { startupCwdFallback: spawnResult.startupCwdFallback }
        : {}),
      ...(spawnResult.agentResumeUnavailable ? { agentResumeUnavailable: true as const } : {})
    }
  }
  return spawnResult.id
}
