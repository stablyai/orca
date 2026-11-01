import { probeAgentProcessPresence } from './agent-process-presence-probe'
import {
  readHookRootEvidence,
  type HookPaneProcessIo,
  type HookRootEvidenceReader
} from './hook-process-root-evidence'
import {
  readSelectedRows,
  readTerminalRows,
  readTmuxPaneBridge
} from './tmux-host-attachment-probe'

/** Root evidence from this host's own processes, for panes whose PTY root `resolveRoot` names. */
export function createLocalHookRootEvidenceReader(
  resolveRoot: HookPaneProcessIo['resolveRoot']
): HookRootEvidenceReader {
  const io: HookPaneProcessIo = {
    resolveRoot,
    probe: (process) => probeAgentProcessPresence(process),
    readProcesses: (pids) => readSelectedRows(pids).catch(() => []),
    readTerminal: (tty) => readTerminalRows(tty).catch(() => []),
    readTmux: readTmuxPaneBridge
  }
  return (request) => readHookRootEvidence(request, io)
}
