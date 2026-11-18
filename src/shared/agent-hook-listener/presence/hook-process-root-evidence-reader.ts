import {
  probeAgentProcessPresence,
  readAgentProcess
} from '../../agent-status/process/agent-process-presence-probe'
import {
  readHookRootEvidence,
  type HookPaneProcessIo,
  type HookRootEvidenceReader
} from './hook-process-root-evidence'
import { PrioritySemaphore } from '../../concurrency/priority-semaphore'
import {
  readSelectedRows,
  readTerminalRows,
  readTmuxPaneBridge,
  type ProcessReadGate
} from './tmux-host-attachment-probe'

// Every pane's acquisition shares this executor's process table: a burst of first hooks queues
// behind four subprocess or proc reads instead of spawning one ps per pane at once.
export function createHookProcessReadSlots(): PrioritySemaphore {
  return new PrioritySemaphore(4)
}

/** Each leaf read holds a slot only while it runs; an expired attempt's queued reads give up. */
export function hookProcessReadGate(
  slots: PrioritySemaphore,
  signal?: AbortSignal
): ProcessReadGate {
  return async (read) => {
    const release = await slots.acquire(0, signal)
    try {
      return await read()
    } finally {
      release()
    }
  }
}

/** Root evidence from this host's own processes, for panes whose PTY root `resolveRoot` names. */
export function createLocalHookRootEvidenceReader(
  resolveRoot: HookPaneProcessIo['resolveRoot'],
  slots = createHookProcessReadSlots()
): HookRootEvidenceReader {
  return (request) => {
    const gate = hookProcessReadGate(slots, request.signal)
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
