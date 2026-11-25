import { inspectRuntimeTerminalProcess } from '@/runtime/hosted-terminals/inspection/runtime-terminal-process-inspection'
import { isRemoteRuntimePtyId } from '../../../../../../shared/remote-runtime/remote-runtime-pty-id'

/** Only a fresh foreground-group read showing nothing but a shell proves the agent exited; anything else submits. */
export async function shellReplacedAgentInPty(ptyId: string): Promise<boolean> {
  // Why: remote runtimes ignore foregroundOnly and would pay a full remote inspection for no evidence.
  if (isRemoteRuntimePtyId(ptyId)) {
    return false
  }
  try {
    const { foregroundObservation: observation } = await inspectRuntimeTerminalProcess(ptyId, {
      foregroundOnly: true
    })
    return observation?.verdict === 'observed' && observation.foregroundKind === 'shell'
  } catch {
    return false
  }
}
