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
  /** The managed Orca server an SSH machine's worktrees run on; kept on gone rows as their link. */
  managedEnvironmentId?: string
  /**
   * The code this desktop last paired with successfully. Pairing codes are credentials, so rows keep
   * `access.pairingCode` empty; an offered code that never paired is not recorded, or a rotated or
   * failed one would be mistaken for current credentials.
   */
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
  /** `machineExpiryWarningKey`s already warned, so a relaunch never repeats a warning. */
  warnedExpiries?: string[]
}

/** One warning per machine per expiry: a provider that moves the expiry earns a new one. */
export function machineExpiryWarningKey(
  machine: Pick<MachineRecord, 'providerKey' | 'id' | 'expiresAt'>
): string {
  return `${machine.providerKey}/${machine.id}@${machine.expiresAt ?? ''}`
}

/** How long before a temporary machine's expiry Orca warns about it. */
export const MACHINE_EXPIRY_WARNING_MS = 15 * 60_000

/** Uncommitted changes, unpushed commits and never-pushed branches on a machine's worktrees. */
export type MachineWorkAtRisk = {
  uncommitted: number
  unpushed: number
  /** Branches with no upstream; optional so older payloads still read. */
  neverPushed?: number
}

/** What main tells the renderer when a temporary machine enters its last 15 minutes. */
export type MachineExpiryWarning = {
  providerKey: MachineProviderKey
  machineId: string
  name: string
  /** Local epoch ms, already shifted from the provider's clock. */
  expiresAt: number
  /** null: the machine's worktrees could not be read, so unsaved work is unknown. */
  workAtRisk: MachineWorkAtRisk | null
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

/** One provider stderr chunk for an action the UI started; stdout is never forwarded. */
export type MachineProgressEvent = {
  operationId: string
  providerKey: MachineProviderKey
  machineId?: string
  verb: 'create' | 'wake' | 'connect'
  stream: 'stderr'
  chunk: string
}

export const MACHINE_CREATE_RECONCILE_WINDOW_MS = 15 * 60_000

export function machineProviderKey(pluginKey: string, providerId: string): MachineProviderKey {
  return `plugin:${pluginKey}/${providerId}`
}

/** After the reconcile window a pending create becomes "Check for a leftover machine". */
export function isStalePendingCreate(pending: MachinePendingCreate, now: number): boolean {
  return now - pending.startedAt > MACHINE_CREATE_RECONCILE_WINDOW_MS
}

/** `expiresAt` as a local epoch, shifted from the provider's clock; null when it never expires. */
export function machineLocalExpiresAt(
  machine: Pick<MachineRecord, 'expiresAt'>,
  clockOffsetMs: number | undefined
): number | null {
  return machine.expiresAt ? Date.parse(machine.expiresAt) - (clockOffsetMs ?? 0) : null
}

/** Milliseconds until `expiresAt` on the provider's clock, or null when the machine never expires. */
export function machineMsUntilExpiry(
  machine: Pick<MachineRecord, 'expiresAt'>,
  clockOffsetMs: number | undefined,
  localNow: number
): number | null {
  const expiresAt = machineLocalExpiresAt(machine, clockOffsetMs)
  return expiresAt === null ? null : expiresAt - localNow
}

/** A translation lookup: the renderer's `translate` or main's `translateMain`. */
export type MachineCopyTranslate = (
  key: string,
  defaultValue: string,
  values: { count: number }
) => string

/** "2 uncommitted changes, 1 unpushed commit, 1 branch never pushed"; null when nothing to lose. */
export function formatMachineWorkAtRisk(
  work: MachineWorkAtRisk,
  t: MachineCopyTranslate
): string | null {
  const parts: string[] = []
  if (work.uncommitted > 0) {
    const count = work.uncommitted
    parts.push(
      count === 1
        ? t('machines.workAtRisk.uncommitted_one', '{{count}} uncommitted change', { count })
        : t('machines.workAtRisk.uncommitted_other', '{{count}} uncommitted changes', { count })
    )
  }
  if (work.unpushed > 0) {
    const count = work.unpushed
    parts.push(
      count === 1
        ? t('machines.workAtRisk.unpushed_one', '{{count}} unpushed commit', { count })
        : t('machines.workAtRisk.unpushed_other', '{{count}} unpushed commits', { count })
    )
  }
  const neverPushed = work.neverPushed ?? 0
  if (neverPushed > 0) {
    parts.push(
      neverPushed === 1
        ? t('machines.workAtRisk.neverPushed_one', '{{count}} branch never pushed', {
            count: neverPushed
          })
        : t('machines.workAtRisk.neverPushed_other', '{{count}} branches never pushed', {
            count: neverPushed
          })
    )
  }
  return parts.length > 0 ? parts.join(', ') : null
}
