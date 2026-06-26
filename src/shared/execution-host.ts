import type { GlobalSettings, Repo } from './types'

export const LOCAL_EXECUTION_HOST_ID = 'local'
export const ALL_EXECUTION_HOSTS_SCOPE = 'all'

export type ExecutionHostKind = 'local' | 'ssh' | 'runtime' | 'devcontainer'
export type ExecutionHostId =
  | typeof LOCAL_EXECUTION_HOST_ID
  | `ssh:${string}`
  | `runtime:${string}`
  | `devcontainer:${string}`

export type ExecutionHostScope = typeof ALL_EXECUTION_HOSTS_SCOPE | ExecutionHostId

export type ParsedExecutionHost =
  | { kind: 'local'; id: typeof LOCAL_EXECUTION_HOST_ID }
  | { kind: 'ssh'; id: `ssh:${string}`; targetId: string }
  | { kind: 'runtime'; id: `runtime:${string}`; environmentId: string }
  // Why containerKey (not a live container id): containers are recreated with a
  // new id, so the host is keyed by something stable (the devcontainer's host
  // folder) and re-resolved to the current container at attach time.
  | { kind: 'devcontainer'; id: `devcontainer:${string}`; containerKey: string }

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

function normalizeHostPart(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

export function toSshExecutionHostId(targetId: string): `ssh:${string}` {
  return `ssh:${encodeURIComponent(targetId)}`
}

export function toRuntimeExecutionHostId(environmentId: string): `runtime:${string}` {
  return `runtime:${encodeURIComponent(environmentId)}`
}

export function toDevcontainerExecutionHostId(containerKey: string): `devcontainer:${string}` {
  return `devcontainer:${encodeURIComponent(containerKey)}`
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
    try {
      const environmentId = decodeURIComponent(encoded)
      return environmentId ? { kind: 'runtime', id: `runtime:${encoded}`, environmentId } : null
    } catch {
      return null
    }
  }
  if (normalized.startsWith('devcontainer:')) {
    const encoded = normalized.slice('devcontainer:'.length)
    if (!encoded) {
      return null
    }
    try {
      const containerKey = decodeURIComponent(encoded)
      return containerKey
        ? { kind: 'devcontainer', id: `devcontainer:${encoded}`, containerKey }
        : null
    } catch {
      return null
    }
  }
  return null
}

export function normalizeExecutionHostId(value: string | null | undefined): ExecutionHostId | null {
  return parseExecutionHostId(value)?.id ?? null
}

/**
 * True when the host's filesystem, git, and worktrees live on THIS machine's
 * disk: a local host, or a devcontainer whose project is bind-mounted from the
 * host. Devcontainers run only the *terminal* inside the container (via
 * `docker exec`); files and git are managed host-side on the same inodes, so
 * they reuse the local providers and local worktree machinery.
 */
export function isLocalFilesystemHost(value: string | null | undefined): boolean {
  const kind = parseExecutionHostId(value)?.kind
  return kind === 'local' || kind === 'devcontainer'
}

export function normalizeExecutionHostScope(value: string | null | undefined): ExecutionHostScope {
  const normalized = normalizeHostPart(value)
  if (!normalized || normalized === ALL_EXECUTION_HOSTS_SCOPE) {
    return ALL_EXECUTION_HOSTS_SCOPE
  }
  return normalizeExecutionHostId(normalized) ?? ALL_EXECUTION_HOSTS_SCOPE
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

export function getRepoExecutionHostId(
  repo: Pick<Repo, 'connectionId' | 'executionHostId'>
): ExecutionHostId {
  const executionHostId = normalizeExecutionHostId(repo.executionHostId)
  if (executionHostId) {
    return executionHostId
  }
  const connectionId = normalizeHostPart(repo.connectionId)
  return connectionId ? toSshExecutionHostId(connectionId) : LOCAL_EXECUTION_HOST_ID
}

export function getSettingsFocusedExecutionHostId(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
): ExecutionHostId {
  const runtimeEnvironmentId = normalizeHostPart(settings?.activeRuntimeEnvironmentId)
  return runtimeEnvironmentId
    ? toRuntimeExecutionHostId(runtimeEnvironmentId)
    : LOCAL_EXECUTION_HOST_ID
}

export function getExecutionHostLabel(id: ExecutionHostScope): string {
  if (id === ALL_EXECUTION_HOSTS_SCOPE) {
    return 'All hosts'
  }
  const parsed = parseExecutionHostId(id)
  if (!parsed) {
    return 'All hosts'
  }
  switch (parsed.kind) {
    case 'local':
      return getLocalExecutionHostLabel()
    case 'ssh':
      return parsed.targetId
    case 'runtime':
      return parsed.environmentId
    case 'devcontainer':
      // Why basename: the key is the devcontainer's host folder; its last
      // segment ("aprium") is the recognizable client/project name.
      return parsed.containerKey.split('/').filter(Boolean).pop() ?? parsed.containerKey
  }
}
