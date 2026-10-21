import type {
  MachineActionResult,
  MachineProviderKey,
  MachineRecord,
  MachineTarget
} from '../../../../shared/machine-inventory'
import type { MachineLifetime } from '../../../../shared/machine-provider-protocol'
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

export type MachineActivity = 'creating' | 'waking' | 'connecting'

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

export async function createMachine(
  providerKey: MachineProviderKey,
  create: {
    operationId: string
    name: string
    lifetime: MachineLifetime
    ttlSeconds?: number
    image?: string
  }
): Promise<MachineStep<MachineRecord>> {
  const created = await window.api.machines.create({
    providerKey,
    operationId: create.operationId,
    name: create.name,
    lifetime: create.lifetime,
    ...(create.ttlSeconds ? { ttlSeconds: create.ttlSeconds } : {}),
    ...(create.image ? { image: create.image } : {})
  })
  if (created.ok) {
    return { ok: true, value: created.value }
  }
  if (created.code === 'conflict') {
    return failed(
      translate(
        'auto.lib.machines.machineStart.nameTaken',
        'A machine named {{name}} already exists. Pick another name in Advanced.',
        { name: create.name }
      ),
      created.message
    )
  }
  return failedAction(
    created,
    translate('auto.lib.machines.machineStart.createFailed', 'Couldn’t create {{name}}.', {
      name: create.name
    })
  )
}

/**
 * What a create with this operation id left behind, read fresh from the provider. `pending` means
 * main is still reconciling an unknown outcome; only `none` proves nothing was made.
 */
export type CreateOutcome =
  | { kind: 'found'; machine: MachineRecord }
  | { kind: 'pending' }
  | { kind: 'none' }
  | { kind: 'unknown'; message: string }

export async function checkCreateOutcome(
  providerKey: MachineProviderKey,
  operationId: string
): Promise<CreateOutcome> {
  const listed = await window.api.machines
    .list({ providerKey, force: true })
    .catch((error: unknown) => ({
      ok: false as const,
      message: error instanceof Error ? error.message : String(error)
    }))
  if (!listed.ok) {
    // Why: losing contact says nothing about whether the machine exists.
    return { kind: 'unknown', message: listed.message }
  }
  const machine = listed.value.machines.find(
    (candidate) => candidate.creatingOperationId === operationId && candidate.state !== 'gone'
  )
  if (machine) {
    return { kind: 'found', machine }
  }
  return listed.value.pendingCreates.some((pending) => pending.operationId === operationId)
    ? { kind: 'pending' }
    : { kind: 'none' }
}

// Matches main's create wait: re-read every 3 s, give up after the provider's create window.
const CREATE_POLL_MS = 3_000
const CREATE_WAIT_MS = 10 * 60_000

/**
 * Waits out a create an earlier attempt left in progress, so the start that follows connects to a
 * running machine instead of failing with "is creating". Null once canceled.
 */
export async function waitForCreatedMachine(
  machine: MachineRecord,
  isCanceled: () => boolean,
  delay: (ms: number) => Promise<void> = (ms) => new Promise((done) => setTimeout(done, ms))
): Promise<MachineStep<MachineRecord> | null> {
  const target = { providerKey: machine.providerKey, machineId: machine.id }
  const deadline = Date.now() + CREATE_WAIT_MS
  let current = machine
  while (current.state === 'creating') {
    if (Date.now() >= deadline) {
      return failed(
        translate(
          'auto.lib.machines.machineStart.createStillRunning',
          'The provider is still creating {{name}}. Try again in a minute.',
          { name: machine.name }
        )
      )
    }
    await delay(CREATE_POLL_MS)
    if (isCanceled()) {
      return null
    }
    const read = await window.api.machines.get(target)
    if (!read.ok) {
      return failedAction(
        read,
        translate('auto.lib.machines.machineStart.readFailed', 'Couldn’t reach {{name}}.', {
          name: machine.name
        })
      )
    }
    current = read.value
  }
  return { ok: true, value: current }
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
