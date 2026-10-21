import type {
  MachineLifetime,
  MachineProviderCapabilities,
  MachineProviderErrorCode,
  ProviderMachine,
  ProviderMachineState
} from './machine-provider-protocol'

/** `plugin:<pluginKey>/<recipeId>`; stable across restarts and plugin updates. */
export type MachineProviderKey = `plugin:${string}/${string}`

/** `unreachable` is the `unverifiable` verdict: loss of contact is never evidence a machine is gone. */
export type MachineState = ProviderMachineState | 'unreachable' | 'gone'

export type MachineRecord = Omit<ProviderMachine, 'state'> & {
  providerKey: MachineProviderKey
  state: MachineState
  /** Local epoch ms of the last provider response that included this machine. */
  lastSeenAt: number
  lastError?: string
  sshTargetId?: string
  runtimeEnvironmentId?: string
  /** Pairing codes are credentials: rows keep `access.pairingCode` empty and store only this. */
  pairingCodeSha256?: string
}

export type MachinePendingCreate = {
  operationId: string
  startedAt: number
  name: string
  lifetime: MachineLifetime
}

export type MachineProviderFailure = {
  code: MachineProviderErrorCode
  message: string
  at: number
}

export type MachineProviderInventory = {
  contextId?: string
  /** provider `now` − local now, so expiry math follows the provider's clock. */
  clockOffsetMs?: number
  capabilities?: MachineProviderCapabilities
  listedAt?: number
  lastFailure?: MachineProviderFailure
  machines: MachineRecord[]
  pendingCreates: MachinePendingCreate[]
}

export type MachineInventoryStore = {
  version: 1
  providers: Record<string, MachineProviderInventory>
}

/** What clients see for one provider: its declaration plus the cached inventory. */
export type MachineProviderSnapshot = MachineProviderInventory & {
  providerKey: MachineProviderKey
  name: string
}

/** Failures keep their provider code; a thrown IPC or RPC error would arrive as text only. */
export type MachineActionResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: MachineProviderErrorCode; message: string }

export type MachineTarget = { providerKey: MachineProviderKey; machineId: string }

export type MachineConnection =
  | { kind: 'ssh'; sshTargetId: string; environmentId?: string }
  | { kind: 'orca-server'; runtimeEnvironmentId: string }

export const MACHINE_CREATE_RECONCILE_WINDOW_MS = 15 * 60_000

export function machineProviderKey(pluginKey: string, providerId: string): MachineProviderKey {
  return `plugin:${pluginKey}/${providerId}`
}

/** After the reconcile window a pending create becomes "Check for a leftover machine". */
export function isStalePendingCreate(pending: MachinePendingCreate, now: number): boolean {
  return now - pending.startedAt > MACHINE_CREATE_RECONCILE_WINDOW_MS
}

/** Milliseconds until `expiresAt` on the provider's clock, or null when the machine never expires. */
export function machineMsUntilExpiry(
  machine: Pick<MachineRecord, 'expiresAt'>,
  clockOffsetMs: number | undefined,
  localNow: number
): number | null {
  if (!machine.expiresAt) {
    return null
  }
  return Date.parse(machine.expiresAt) - (localNow + (clockOffsetMs ?? 0))
}
