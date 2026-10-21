import type {
  MachineActionResult,
  MachineRecord,
  MachineTarget
} from '../../../../shared/machine-inventory'
import { toRuntimeExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { machineNeedsWake } from './machine-display-state'
import { describeMachineFailure } from './machine-copy'
import { wakeMachine } from './machine-wake'

/** A failed step: one plain sentence to show, and the raw cause for the log. */
export type MachineStep<T> = { ok: true; value: T } | { ok: false; error: string; detail?: string }

export type StartedMachine = {
  hostId: ExecutionHostId
  projectRoot: string
  environmentId: string
}

export type MachineActivity = 'waking' | 'connecting'

type StartOptions = {
  name: string
  /** Tags this start's provider output so only its own lines reach the log. */
  operationId: string
  onActivity: (activity: MachineActivity) => void
  /** Checked between steps; a canceled start stops before the next provider call. */
  isCanceled: () => boolean
}

function failed<T>(error: string, detail?: string): MachineStep<T> {
  return { ok: false, error, ...(detail ? { detail } : {}) }
}

function failedAction<T>(
  result: Extract<MachineActionResult<unknown>, { ok: false }>,
  sentence: string
): MachineStep<T> {
  return failed(`${sentence} ${describeMachineFailure(result.code)}`, result.message)
}

/** Provider stderr for one operation, until the returned function is called. */
export function subscribeMachineProgress(
  operationId: string,
  onChunk: (chunk: string) => void
): () => void {
  return window.api.machines.onProgress((event) => {
    if (event.operationId === operationId) {
      onChunk(event.chunk)
    }
  })
}

/** Why the SSH host has no Orca server, in the connection's own words. */
function managedServerBlocker(sshTargetId: string): string | undefined {
  const managed = useAppStore.getState().sshConnectionStates.get(sshTargetId)?.managedServer
  return managed?.kind === 'relay' ? (managed.detail ?? managed.reason) : undefined
}

function machineProjectRoot(machine: MachineRecord): string | null {
  return machine.access?.projectRoot ?? null
}

/**
 * Wakes a stopped machine, connects to it and reads where projects live. A sleeping or archived
 * machine is woken here, on submit, so choosing it in the composer never waits. Returns null
 * once canceled.
 */
export async function startMachine(
  target: MachineTarget,
  options: StartOptions
): Promise<MachineStep<StartedMachine> | null> {
  const { name, operationId } = options
  const machines = window.api.machines
  const current = await machines.get(target)
  if (options.isCanceled()) {
    return null
  }
  if (!current.ok) {
    return failedAction(
      current,
      translate('auto.lib.machines.machineStart.readFailed', 'Couldn’t reach {{name}}.', { name })
    )
  }
  if (current.value.state === 'gone') {
    return failed(translate('auto.lib.machines.machineStart.gone', '{{name}} is gone.', { name }))
  }
  if (machineNeedsWake(current.value.state)) {
    options.onActivity('waking')
    const woken = await wakeMachine(target, { operationId })
    if (options.isCanceled()) {
      return null
    }
    if (!woken.ok) {
      return failedAction(
        woken,
        translate('auto.lib.machines.machineStart.wakeFailed', 'Couldn’t wake {{name}}.', { name })
      )
    }
  }
  options.onActivity('connecting')
  const connection = await machines.connect({ ...target, operationId })
  if (options.isCanceled()) {
    return null
  }
  if (!connection.ok) {
    return failedAction(
      connection,
      translate('auto.lib.machines.machineStart.connectFailed', 'Couldn’t connect to {{name}}.', {
        name
      })
    )
  }
  // Why: access is only reported while running, so read it after the wake settled.
  const running = await machines.get(target)
  if (options.isCanceled()) {
    return null
  }
  if (!running.ok) {
    return failedAction(
      running,
      translate('auto.lib.machines.machineStart.readFailed', 'Couldn’t reach {{name}}.', { name })
    )
  }
  const projectRoot = machineProjectRoot(running.value)
  if (!projectRoot) {
    return failed(
      translate(
        'auto.lib.machines.machineStart.noProjectRoot',
        'The provider didn’t say where projects live on {{name}}.',
        { name }
      )
    )
  }
  const { value } = connection
  const environmentId =
    value.kind === 'orca-server' ? value.runtimeEnvironmentId : value.environmentId
  if (!environmentId) {
    // Why: an SSH host sets projects up only through the Orca server it runs there.
    return failed(
      translate(
        'auto.lib.machines.machineStart.noServer',
        'Orca couldn’t start its server on {{name}}, which it needs to set up the project.',
        { name }
      ),
      value.kind === 'ssh' ? managedServerBlocker(value.sshTargetId) : undefined
    )
  }
  return {
    ok: true,
    value: { hostId: toRuntimeExecutionHostId(environmentId), projectRoot, environmentId }
  }
}
