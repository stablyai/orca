import { toast } from 'sonner'
import type { MachineProviderErrorCode } from '../../../../shared/machine-provider-protocol'
import { getMachineSources } from '@/store/machines'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { machineNeedsWake } from './machine-display-state'
import { describeMachineFailure } from './machine-copy'
import {
  findMachineForHost,
  machineHostKeyForWorktree,
  type MachineMatch
} from './machine-host-match'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import { wakeMachine } from './machine-wake'

type WakeOutcome = { ok: true } | { ok: false; code: MachineProviderErrorCode | null }

async function wakeAndConnect(match: MachineMatch): Promise<WakeOutcome> {
  const target = { providerKey: match.snapshot.providerKey, machineId: match.machine.id }
  const woken = await wakeMachine(target, { environmentId: match.environmentId })
  if (!woken.ok) {
    return { ok: false, code: woken.code }
  }
  if (match.environmentId !== null) {
    return { ok: true }
  }
  // Why: reconnecting now spares the terminal its first reconnect attempt against a cold host.
  const connected = await window.api.machines.connect(target)
  return connected.ok ? { ok: true } : { ok: false, code: connected.code }
}

function describeWakeFailure(code: MachineProviderErrorCode | null): string {
  return code
    ? describeMachineFailure(code)
    : translate(
        'auto.lib.machines.machineWakeOnOpen.wakeFailedUnknown',
        'Orca couldn’t reach the machine’s provider.'
      )
}

/**
 * A wake announced once per machine: a toast only when no terminal can say it instead. The toast
 * id is the machine's, so opening it twice while it wakes shows one toast.
 */
function startAnnouncedWake(
  match: MachineMatch,
  worktreeId: string | undefined
): Promise<WakeOutcome> {
  const name = match.machine.name
  const store = useAppStore.getState()
  const hasTerminals = worktreeId ? (store.tabsByWorktree[worktreeId]?.length ?? 0) > 0 : false
  const machineToastId = `machine-wake:${match.environmentId ?? 'local'}:${match.snapshot.providerKey}:${match.machine.id}`
  const toastId = hasTerminals
    ? undefined
    : toast.loading(
        translate('auto.lib.machines.machineWakeOnOpen.waking', 'Waking {{name}}…', { name }),
        { id: machineToastId }
      )
  return wakeAndConnect(match)
    .catch((): WakeOutcome => ({ ok: false, code: null }))
    .then((outcome) => {
      if (toastId === undefined) {
        return outcome
      }
      if (outcome.ok) {
        toast.dismiss(toastId)
      } else {
        toast.error(
          translate('auto.lib.machines.machineWakeOnOpen.wakeFailed', 'Couldn’t wake {{name}}', {
            name
          }),
          { id: toastId, description: describeWakeFailure(outcome.code) }
        )
      }
      return outcome
    })
}

/**
 * Opening a worktree whose machine sleeps (or is archived) wakes it; main joins repeat opens into
 * the one wake already running. Navigation never waits on this. The worktree is marked until wake and connect
 * settle, so its terminals hold their attach and name the wake (or its failure) in one place.
 */
export function wakeMachineForHost(
  hostId: string | null | undefined,
  worktreeId?: string
): Promise<void> {
  const match = findMachineForHost(hostId, getMachineSources())
  const store = useAppStore.getState()
  if (!hostId || !match || !machineNeedsWake(match.machine.state)) {
    // Why: a Retry after the machine woke some other way releases the held terminals.
    if (worktreeId && store.machineWakeByWorktreeId[worktreeId]) {
      store.setWorktreeMachineWake(worktreeId, null)
    }
    return Promise.resolve()
  }
  const machineName = match.machine.name
  if (worktreeId) {
    store.setWorktreeMachineWake(worktreeId, { machineName, hostId, failure: null })
  }
  const run = startAnnouncedWake(match, worktreeId)
  return run.then((outcome) => {
    if (worktreeId) {
      useAppStore
        .getState()
        .setWorktreeMachineWake(
          worktreeId,
          outcome.ok ? null : { machineName, hostId, failure: describeWakeFailure(outcome.code) }
        )
    }
  })
}

/**
 * The Wake button on a stopped machine's surfaces: the same wake as opening the worktree, so a
 * terminal holds its attach and names the outcome. Without a worktree it still wakes, announced.
 */
export function wakeStoppedMachine(match: MachineMatch, worktreeId?: string): Promise<void> {
  if (worktreeId) {
    const state = useAppStore.getState()
    const worktree = findWorktreeById(state.worktreesByRepo, worktreeId)
    const repo = worktree ? state.repos.find((candidate) => candidate.id === worktree.repoId) : null
    const hostKey = worktree ? machineHostKeyForWorktree(worktree, repo) : null
    if (hostKey) {
      return wakeMachineForHost(hostKey, worktreeId)
    }
  }
  return machineNeedsWake(match.machine.state)
    ? startAnnouncedWake(match, undefined).then(() => undefined)
    : Promise.resolve()
}
