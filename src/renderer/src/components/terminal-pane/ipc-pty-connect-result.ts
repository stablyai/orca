import { terminalLaunchFacts } from '../../../../shared/agent-session-resume'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import type { PtyConnectResult } from './pty-transport-types'

type IpcPtySpawnResult = PtyConnectResult & { isReattach?: boolean }

export function projectIpcPtyConnectResult(
  spawnResult: IpcPtySpawnResult
): string | PtyConnectResult {
  const launchAgent = isTuiAgent(spawnResult.launchAgent) ? spawnResult.launchAgent : undefined
  const facts = terminalLaunchFacts({ ...spawnResult, launchAgent })
  if (spawnResult.isReattach || spawnResult.coldRestore || spawnResult.sessionExpired) {
    return {
      ...facts,
      ...(spawnResult.incarnationId ? { incarnationId: spawnResult.incarnationId } : {}),
      id: spawnResult.id,
      ...(spawnResult.isReattach ? { isReattach: true } : {}),
      ...(launchAgent ? { launchAgent } : {}),
      ...(spawnResult.launchConfig ? { launchConfig: spawnResult.launchConfig } : {}),
      snapshot: spawnResult.snapshot,
      snapshotCols: spawnResult.snapshotCols,
      snapshotRows: spawnResult.snapshotRows,
      ...(spawnResult.snapshotSeq !== undefined ? { snapshotSeq: spawnResult.snapshotSeq } : {}),
      ...(spawnResult.snapshotKittyKeyboardFlags !== undefined
        ? { snapshotKittyKeyboardFlags: spawnResult.snapshotKittyKeyboardFlags }
        : {}),
      ...(spawnResult.snapshotPrefixAnsi !== undefined
        ? { snapshotPrefixAnsi: spawnResult.snapshotPrefixAnsi }
        : {}),
      ...(spawnResult.snapshotFrameAnsi !== undefined
        ? { snapshotFrameAnsi: spawnResult.snapshotFrameAnsi }
        : {}),
      ...(spawnResult.snapshotFrameRestoreAnsi !== undefined
        ? { snapshotFrameRestoreAnsi: spawnResult.snapshotFrameRestoreAnsi }
        : {}),
      ...(spawnResult.snapshotTerminalOwner
        ? { snapshotTerminalOwner: spawnResult.snapshotTerminalOwner }
        : {}),
      isAlternateScreen: spawnResult.isAlternateScreen,
      sessionExpired: spawnResult.sessionExpired,
      coldRestore: spawnResult.coldRestore,
      replay: spawnResult.replay,
      pendingEscapeTailAnsi: spawnResult.pendingEscapeTailAnsi,
      ...(spawnResult.startupCwdFallback
        ? { startupCwdFallback: spawnResult.startupCwdFallback }
        : {}),
      ...(spawnResult.agentResumeUnavailable ? { agentResumeUnavailable: true as const } : {}),
      ...(spawnResult.agentResumeRefused
        ? { agentResumeRefused: spawnResult.agentResumeRefused }
        : {})
    }
  }
  if (
    launchAgent ||
    spawnResult.launchConfig ||
    spawnResult.startupCwdFallback ||
    spawnResult.agentResumeUnavailable ||
    spawnResult.savedResumeDecision ||
    spawnResult.refusedResume ||
    spawnResult.launchToken
  ) {
    return {
      ...facts,
      ...(spawnResult.incarnationId ? { incarnationId: spawnResult.incarnationId } : {}),
      id: spawnResult.id,
      ...(launchAgent ? { launchAgent } : {}),
      ...(spawnResult.launchConfig ? { launchConfig: spawnResult.launchConfig } : {}),
      ...(spawnResult.startupCwdFallback
        ? { startupCwdFallback: spawnResult.startupCwdFallback }
        : {}),
      ...(spawnResult.agentResumeUnavailable ? { agentResumeUnavailable: true as const } : {}),
      ...(spawnResult.agentResumeRefused
        ? { agentResumeRefused: spawnResult.agentResumeRefused }
        : {})
    }
  }
  return spawnResult.id
}
