import { translate } from '@/i18n/i18n'
import { formatShortTimeAgo } from '@/lib/short-time-ago'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'
import type { ResumeCandidate, ResumeFailure } from './native-chat-resume-on-restart-grouping'
import type { ResumeFailureAction } from './native-chat-resume-failure-guidance'
import type { MachineView } from './native-chat-resume-machine-views'
import type { RestartMachineKey } from './native-chat-restart-machines'
import { resumeCandidateOwnership, resumeOwnershipLabel } from './native-chat-resume-ownership'
import { resumeRowKey, resumeRowSelectedByDefault } from './native-chat-resume-selection'

/**
 * The resume tree over every listed machine. The tree groups by each chat's host; a paired server's
 * chats all carry its runtime host, while this computer's may also sit on its SSH hosts. Each chat
 * is keyed by its machine's listing identity and session id, since two servers may hold one id.
 */
export type ResumeTreeMachines = {
  rows: ResumeCandidate[]
  /** The newest listing's time, which each chat's age is measured to. */
  listedAt: number
  rowKey: (candidate: ResumeCandidate) => string
  busyFor: (hostId: ExecutionHostId) => boolean
  failureFor: (key: string) => ResumeFailure | undefined
  originLabelFor: (key: string) => string | undefined
  defaultExpanded: (nodeKey: string) => boolean
  machineSubtitle: (hostId: ExecutionHostId) => string | undefined
  /** The listing a host's chats came from: its machine and the pairing it was read under. */
  listingOf: (hostId: ExecutionHostId) => string
  /** The machine and session a key names, for the row's own actions. */
  rowOf: (key: string) => { machine: MachineView; sessionId: string } | undefined
}

/** Why a machine's chats stopped and how long ago, beside its name. */
function machineSubtitleFor(machine: MachineView, rows: readonly ResumeCandidate[]): string {
  const cause = rows.some((row) => row.trigger === 'update')
    ? translate(
        'auto.components.NativeChatResumeOnRestartModal.machineCauseUpdate',
        'Installed an update'
      )
    : translate('auto.components.NativeChatResumeOnRestartModal.machineCauseQuit', 'Was quit')
  const latest = Math.max(...rows.map((row) => row.recordedAt))
  return `${cause} · ${formatShortTimeAgo(latest, machine.offer.listedAt)}`
}

/** `rowsOf` is what each machine shows: by default its listed rows, or a run's rows while the
 *  dialog follows one, which keep a chat the host no longer lists. */
export function resumeTreeMachines(
  machines: readonly MachineView[],
  resuming: ReadonlyMap<RestartMachineKey, readonly string[]>,
  focus: RestartMachineKey | null,
  rowsOf: (machine: MachineView) => readonly ResumeCandidate[] = (machine) => machine.rows
): ResumeTreeMachines {
  const machineOfRow = new Map<ResumeCandidate, MachineView>()
  // Keyed by plain string: the tree names a machine node by its host id inside a string key.
  const machineByHost = new Map<string, MachineView>()
  const rowByKey = new Map<
    string,
    { machine: MachineView; sessionId: string; candidate: ResumeCandidate }
  >()
  const shown = new Map(machines.map((machine) => [machine, rowsOf(machine)]))
  for (const [machine, rows] of shown) {
    for (const row of rows) {
      machineOfRow.set(row, machine)
      machineByHost.set(row.executionHostId ?? LOCAL_EXECUTION_HOST_ID, machine)
      rowByKey.set(resumeRowKey(machine.identity, row.sessionId), {
        machine,
        sessionId: row.sessionId,
        candidate: row
      })
    }
  }
  const lookup = <T>(key: string, read: (machine: MachineView, sessionId: string) => T) => {
    const row = rowByKey.get(key)
    return row ? read(row.machine, row.sessionId) : undefined
  }
  return {
    rows: [...shown.values()].flat(),
    listedAt: Math.max(...machines.map((machine) => machine.offer.listedAt)),
    rowKey: (candidate) => {
      const machine = machineOfRow.get(candidate)
      return machine ? resumeRowKey(machine.identity, candidate.sessionId) : candidate.sessionId
    },
    busyFor: (hostId) => {
      const machine = machineByHost.get(hostId)
      return machine !== undefined && resuming.has(machine.machine)
    },
    failureFor: (key) => lookup(key, (machine, sessionId) => machine.failureFor(sessionId)),
    // Read from the row shown, which may be a run's copy of a chat its host no longer lists.
    originLabelFor: (key) => {
      const row = rowByKey.get(key)
      return row
        ? resumeOwnershipLabel(resumeCandidateOwnership(row.candidate), row.machine.name)
        : undefined
    },
    // A machine starts open when the dialog was opened for it, when it is the only one listed, or
    // when nothing on it starts ticked (so its empty box is explained); every other node is open.
    defaultExpanded: (nodeKey) => {
      const hostId = nodeKey.startsWith('machine:') ? nodeKey.slice('machine:'.length) : null
      const machine = hostId === null ? undefined : machineByHost.get(hostId)
      return (
        machine === undefined ||
        focus === machine.machine ||
        machines.length === 1 ||
        !machine.rows.some((row) =>
          resumeRowSelectedByDefault(
            machine.ownershipFor(row.sessionId),
            machine.failureFor(row.sessionId)
          )
        )
      )
    },
    machineSubtitle: (hostId) => {
      const machine = machineByHost.get(hostId)
      return machine ? machineSubtitleFor(machine, shown.get(machine) ?? []) : undefined
    },
    listingOf: (hostId) => machineByHost.get(hostId)?.identity ?? hostId,
    rowOf: (key) => rowByKey.get(key)
  }
}

/** A row's own action, routed to the machine that listed it. */
export function resumeTreeRowAction(
  tree: ResumeTreeMachines,
  key: string,
  act: (machine: MachineView, action: ResumeFailureAction, sessionId: string) => void,
  action: ResumeFailureAction
): void {
  const row = tree.rowOf(key)
  if (row) {
    act(row.machine, action, row.sessionId)
  }
}
