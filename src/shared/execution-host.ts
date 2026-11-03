import type { GlobalSettings } from './global-settings-types'
import type { Repo } from './repo-types'
import type { Worktree } from './worktree/types'

export const LOCAL_EXECUTION_HOST_ID = 'local'
export const ALL_EXECUTION_HOSTS_SCOPE = 'all'

export type ExecutionHostKind = 'local' | 'ssh' | 'runtime'
export type ExecutionHostId = typeof LOCAL_EXECUTION_HOST_ID | `ssh:${string}` | `runtime:${string}`

export type ExecutionHostScope = typeof ALL_EXECUTION_HOSTS_SCOPE | ExecutionHostId

/** Whether work at this location runs natively on this machine, in a folder this process can read. */
export function isNativeLocalLocation(location: {
  executionHostId: string
  wslDistro: string | null
}): boolean {
  return location.executionHostId === LOCAL_EXECUTION_HOST_ID && location.wslDistro === null
}

export type ParsedExecutionHost =
  | { kind: 'local'; id: typeof LOCAL_EXECUTION_HOST_ID }
  | { kind: 'ssh'; id: `ssh:${string}`; targetId: string }
  | { kind: 'runtime'; id: `runtime:${string}`; environmentId: string }

function getCurrentLocalPlatform(): NodeJS.Platform | null {
  const globalNavigator = (globalThis as { navigator?: { userAgent?: string; platform?: string } })
    .navigator
  const userAgent = globalNavigator?.userAgent || globalNavigator?.platform || ''
  if (/Windows/i.test(userAgent)) {
    return 'win32'
  }
  if (/Mac/i.test(userAgent)) {
    return 'darwin'
  }
  if (/Linux|X11/i.test(userAgent)) {
    return 'linux'
  }
  return typeof process === 'undefined' ? null : process.platform
}

export function getLocalExecutionHostLabel(platform: NodeJS.Platform | null = null): string {
  const localPlatform = platform ?? getCurrentLocalPlatform()
  if (localPlatform === 'darwin') {
    return 'Local Mac'
  }
  if (localPlatform === 'win32') {
    return 'Local Windows'
  }
  if (localPlatform === 'linux') {
    return 'Local Linux'
  }
  return 'This computer'
}

/** Trims a stored id; blank is absent, since no write path normalizes it. */
export function normalizeHostPart(value: string | null | undefined): string | null {
  return value?.trim() || null
}

export function toSshExecutionHostId(targetId: string): `ssh:${string}` {
  return `ssh:${encodeURIComponent(targetId)}`
}

/** Legacy `connectionId` spelling: absent means this machine, present means that SSH target. */
export function getConnectionExecutionHostId(
  connectionId: string | null | undefined
): ExecutionHostId {
  return connectionId ? toSshExecutionHostId(connectionId) : LOCAL_EXECUTION_HOST_ID
}

export function toRuntimeExecutionHostId(environmentId: string): `runtime:${string}` {
  return `runtime:${encodeURIComponent(environmentId)}`
}

// Renderer lacks target.owner, so deterministic prefixes identify hidden plumbing; main shares this prefix.
// Only recipe VMs use runtime-ssh-: each provision replaces their address/filesystem. Main hides targets by owner.
export const RUNTIME_OWNED_SSH_TARGET_ID_PREFIX = 'runtime-ssh-'
/** Machine-provider targets: owned like recipe VMs, but persistent, so not `runtime-ssh-`. */
export const MACHINE_SSH_TARGET_ID_PREFIX = 'machine-'

/** A recipe VM's target, whose address and filesystem are replaced every provision. */
export function isRuntimeOwnedSshTargetId(targetId: string | null | undefined): boolean {
  return typeof targetId === 'string' && targetId.startsWith(RUNTIME_OWNED_SSH_TARGET_ID_PREFIX)
}

/** Renderer identifies owned plumbing by id because owner is unavailable; direct dialing would dispose its owner’s session. */
export function isOwnedSshTargetId(targetId: string | null | undefined): boolean {
  return (
    isRuntimeOwnedSshTargetId(targetId) ||
    (typeof targetId === 'string' && targetId.startsWith(MACHINE_SSH_TARGET_ID_PREFIX))
  )
}

export function parseExecutionHostId(value: string | null | undefined): ParsedExecutionHost | null {
  const normalized = normalizeHostPart(value)
  if (!normalized) {
    return null
  }
  if (normalized === LOCAL_EXECUTION_HOST_ID) {
    return { kind: 'local', id: LOCAL_EXECUTION_HOST_ID }
  }
  if (normalized.startsWith('ssh:')) {
    const encoded = normalized.slice('ssh:'.length)
    if (!encoded) {
      return null
    }
    // An unencoded | would rebind composeWorktreeHostIdentity’s first-delimiter alias to another host.
    if (encoded.includes('|')) {
      return null
    }
    try {
      const targetId = decodeURIComponent(encoded)
      return targetId ? { kind: 'ssh', id: `ssh:${encoded}`, targetId } : null
    } catch {
      return null
    }
  }
  if (normalized.startsWith('runtime:')) {
    const encoded = normalized.slice('runtime:'.length)
    if (!encoded) {
      return null
    }
    if (encoded.includes('|')) {
      return null
    }
    try {
      const environmentId = decodeURIComponent(encoded)
      return environmentId ? { kind: 'runtime', id: `runtime:${encoded}`, environmentId } : null
    } catch {
      return null
    }
  }
  return null
}

/** True only for an explicit local host id; absent or unparsable ids return false. */
export function isLocalExecutionHost(value: string | null | undefined): boolean {
  return parseExecutionHostId(value)?.kind === 'local'
}

export function isRemoteExecutionHostId(value: string | null | undefined): boolean {
  return (parseExecutionHostId(value)?.kind ?? 'local') !== 'local'
}

/** Conflict sentinel uses runtime spelling to prevent local treatment; no environment owns it and it must never be dialed. */
export const UNRESOLVED_OWNER_HOST_ID = 'runtime:unresolved-owner' satisfies ExecutionHostId

export function isUnresolvedOwnerHostId(value: string | null | undefined): boolean {
  return parseExecutionHostId(value)?.id === UNRESOLVED_OWNER_HOST_ID
}

/** {@link parseExecutionHostId} for transports: the unresolved-owner sentinel is not a host. */
export function parseRoutableExecutionHostId(
  value: string | null | undefined
): ParsedExecutionHost | null {
  const parsed = parseExecutionHostId(value)
  return parsed?.id === UNRESOLVED_OWNER_HOST_ID ? null : parsed
}

export function normalizeExecutionHostId(value: string | null | undefined): ExecutionHostId | null {
  return parseExecutionHostId(value)?.id ?? null
}

export function normalizeExecutionHostScope(value: string | null | undefined): ExecutionHostScope {
  const normalized = normalizeHostPart(value)
  if (!normalized || normalized === ALL_EXECUTION_HOSTS_SCOPE) {
    return ALL_EXECUTION_HOSTS_SCOPE
  }
  return normalizeExecutionHostId(normalized) ?? ALL_EXECUTION_HOSTS_SCOPE
}

// An omitted request scope means this host; share the rule so renderer and callers agree on fan-out.
export function requestedExecutionHostScope(value: string | null | undefined): ExecutionHostScope {
  return normalizeExecutionHostScope(value ?? LOCAL_EXECUTION_HOST_ID)
}

export function normalizeVisibleExecutionHostIds(
  value: readonly string[] | null | undefined
): ExecutionHostId[] | null {
  if (!Array.isArray(value)) {
    return null
  }
  const ids: ExecutionHostId[] = []
  const seen = new Set<ExecutionHostId>()
  for (const raw of value) {
    const id = normalizeExecutionHostId(raw)
    if (!id || seen.has(id)) {
      continue
    }
    seen.add(id)
    ids.push(id)
  }
  return ids.length > 0 ? ids : null
}

export function normalizeExecutionHostOrder(
  value: readonly string[] | null | undefined
): ExecutionHostId[] {
  const normalized = normalizeVisibleExecutionHostIds(value)
  return normalized ?? []
}

// Wire readers supply strings; this function owns invalid-id interpretation.
export function getRepoExecutionHostId(repo: {
  connectionId?: string | null
  executionHostId?: string | null
}): ExecutionHostId {
  const executionHostId = normalizeExecutionHostId(repo.executionHostId)
  if (executionHostId) {
    return executionHostId
  }
  return getConnectionExecutionHostId(normalizeHostPart(repo.connectionId))
}

/** True only for catalog-local files; unknown hosts or a stale connectionId beside local cannot prove locality. */
export function isRepoOnCatalogHost(repo: {
  connectionId?: string | null
  executionHostId?: string | null
}): boolean {
  const executionHostId = normalizeHostPart(repo.executionHostId)
  return (
    (executionHostId === null || executionHostId === LOCAL_EXECUTION_HOST_ID) &&
    normalizeHostPart(repo.connectionId) === null
  )
}

/** Legacy automation migration distinguishes an SSH stamp from a legacy dial target. */
export function isRepoSshOnlyHost(repo: Pick<Repo, 'connectionId' | 'executionHostId'>): boolean {
  return (
    normalizeHostPart(repo.connectionId) === null &&
    parseExecutionHostId(repo.executionHostId)?.kind === 'ssh'
  )
}

export function getSshTargetIdForExecutionHost(
  executionHostId: string | null | undefined
): string | null {
  const parsed = parseExecutionHostId(executionHostId)
  return parsed?.kind === 'ssh' ? parsed.targetId : null
}

/** The SSH target this client may dial for a row's files; null for local and `runtime:` rows. */
export function getRepoDialableSshTargetId(
  repo: Pick<Repo, 'connectionId' | 'executionHostId'>
): string | null {
  return getSshTargetIdForExecutionHost(getRepoExecutionHostId(repo))
}

// Resolve both legacy connectionId and unified ssh:<target> ownership or SSH-only rows would execute locally.
// A connectionId beside local contradicts ownership and is ignored. Beside runtime:<env>, it names that environment’s nested SSH target.
// Keep nested targets for transcript/SSH-status reads (selectRuntimeAwareSshStatus); dropping them misclassifies remote files as local.
// This identifies the filesystem’s SSH target. Client PTY/Git routing must use getRepoDialableSshTargetId, since nested targets require an environment too.
export function getRepoSshConnectionId(
  repo: Pick<Repo, 'connectionId' | 'executionHostId'>
): string | null {
  const host = parseExecutionHostId(getRepoExecutionHostId(repo))
  if (host?.kind === 'ssh') {
    return host.targetId
  }
  return host?.kind === 'runtime' ? normalizeHostPart(repo.connectionId) : null
}

/** Resolve both SSH spellings for routing checks; a raw connectionId never reads as local, and ssh:B overrides stale connectionId A. */
export function getRepoRoutingConnectionId(
  repo: Pick<Repo, 'connectionId' | 'executionHostId'>
): string | null {
  return getRepoDialableSshTargetId(repo) ?? normalizeHostPart(repo.connectionId)
}

export function getWorktreeExecutionHostId(
  worktree: Pick<Worktree, 'hostId'>,
  repo: Pick<Repo, 'connectionId' | 'executionHostId'> | undefined,
  defaultHostId: ExecutionHostId = LOCAL_EXECUTION_HOST_ID
): ExecutionHostId {
  // Snapshots can identify a more precise owner than the repo; share precedence across sidebar decisions.
  return worktree.hostId ?? getRepoExecutionHostIdOrDefault(repo, defaultHostId)
}

/** A repo's explicit execution owner; repos without one belong to the focused/default host. */
export function getRepoExecutionHostIdOrDefault(
  repo: Pick<Repo, 'connectionId' | 'executionHostId'> | undefined,
  defaultHostId: ExecutionHostId
): ExecutionHostId {
  return repo?.connectionId || repo?.executionHostId ? getRepoExecutionHostId(repo) : defaultHostId
}

export function getSettingsFocusedExecutionHostId(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
): ExecutionHostId {
  const runtimeEnvironmentId = normalizeHostPart(settings?.activeRuntimeEnvironmentId)
  return runtimeEnvironmentId
    ? toRuntimeExecutionHostId(runtimeEnvironmentId)
    : LOCAL_EXECUTION_HOST_ID
}

export function getExecutionHostLabel(id: ExecutionHostScope | null | undefined): string {
  if (id === ALL_EXECUTION_HOSTS_SCOPE) {
    return 'All hosts'
  }
  const parsed = parseExecutionHostId(id)
  if (!parsed) {
    // An invalid id denotes one unknown host, not All hosts. Keep English consistent with other non-i18n host labels.
    return 'Unknown host'
  }
  switch (parsed.kind) {
    case 'local':
      return getLocalExecutionHostLabel()
    case 'ssh':
      return parsed.targetId
    case 'runtime':
      return parsed.environmentId
  }
}
