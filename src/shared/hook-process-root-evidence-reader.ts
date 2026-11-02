import { probeAgentProcessPresence, readAgentProcess } from './agent-process-presence-probe'
import {
  readHookRootEvidence,
  type HookPaneProcessIo,
  type HookRootEvidenceReader
} from './hook-process-root-evidence'
import { PrioritySemaphore } from './priority-semaphore'
import {
  readSelectedRows,
  readTerminalRows,
  readTmuxPaneBridge,
  type ProcessReadGate
} from './tmux-host-attachment-probe'

// Every pane's acquisition shares this executor's process table: a burst of first hooks queues
// behind four subprocess or proc reads instead of spawning one ps per pane at once.
const MAX_ACTIVE_HOOK_ROOT_READS = 4

/** Root evidence from this host's own processes, for panes whose PTY root `resolveRoot` names. */
export function createLocalHookRootEvidenceReader(
  resolveRoot: HookPaneProcessIo['resolveRoot'],
  slots = new PrioritySemaphore(MAX_ACTIVE_HOOK_ROOT_READS)
): HookRootEvidenceReader {
  return (request) => {
    // Each leaf read holds a slot only while it runs; an expired attempt's queued reads give up.
    const gate: ProcessReadGate = async (read) => {
      const release = await slots.acquire(0, request.signal)
      try {
        return await read()
      } finally {
        release()
      }
    }
    const io: HookPaneProcessIo = {
      resolveRoot,
      probe: (process) =>
        probeAgentProcessPresence(process, (pid) => gate(() => readAgentProcess(pid))),
      readProcesses: (pids) => readSelectedRows(pids, gate).catch(() => []),
      readTerminal: (tty) => readTerminalRows(tty, gate).catch(() => []),
      readTmux: (socket, rootPid, pane) => readTmuxPaneBridge(socket, rootPid, pane, gate)
    }
    return readHookRootEvidence(request, io)
  }
}
