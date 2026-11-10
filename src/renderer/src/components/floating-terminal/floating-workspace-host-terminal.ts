import {
  runtimeHostPlatform,
  type PtyOwnerMachineState
} from '@/components/terminal-pane/pty-transport/host-ownership/pty-owner-machine-platform'
import type { TerminalCreationExecutionFacts } from '@/store/terminals/terminal-contracts'
import { parseExecutionHostId } from '../../../../shared/execution-host'

/**
 * Creation facts for a floating tab on a paired Orca server; null keeps the tab on this computer.
 * No directory rides along: the server starts the tab in its own floating directory, since this
 * client's directory and trusted folders name paths on this computer only.
 */
export function floatingWorkspaceHostExecutionFacts(
  state: PtyOwnerMachineState,
  hostId: string | null | undefined
): TerminalCreationExecutionFacts | null {
  const host = parseExecutionHostId(hostId)
  if (host?.kind !== 'runtime') {
    return null
  }
  return {
    hostId: host.id,
    connectionId: null,
    platform: runtimeHostPlatform(state, host.environmentId),
    isRemote: true,
    isWsl: false
  }
}
