export type TerminalBackend = 'orca' | 'herdr'

export type TerminalBackendPreference = 'inherit' | TerminalBackend

export type HerdrBinarySource = { kind: 'system' } | { kind: 'custom'; path: string }

/** How the herdr terminal backend runs on the local host. 'daemon' uses Orca's
 *  built-in in-app herdr daemon; 'stock' spawns or attaches to the stock herdr
 *  binary resolved via `herdrBinarySource`, producing a session the stock herdr
 *  client can see. */
export type HerdrRuntimeSource = 'daemon' | 'stock'

/** Shared stock herdr session name for Orca-managed terminals when no
 *  per-project override is set. Users can edit or clear it. */
export const DEFAULT_HERDR_SESSION_NAME = 'orca'

/** Max length for a herdr session name; on macOS the name feeds the daemon
 *  unix socket path, so oversized values are rejected to avoid the sun_path
 *  limit. Mirrors the per-project IPC bound. */
export const HERDR_SESSION_NAME_MAX_LENGTH = 64

export function normalizeHerdrSessionName(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > HERDR_SESSION_NAME_MAX_LENGTH) {
    return undefined
  }
  return trimmed
}

export function normalizeTerminalBackend(value: unknown): TerminalBackend {
  return value === 'herdr' ? 'herdr' : 'orca'
}

export function normalizeHerdrRuntimeSource(value: unknown): HerdrRuntimeSource {
  return value === 'stock' ? 'stock' : 'daemon'
}

export function normalizeHerdrBinarySource(value: unknown): HerdrBinarySource {
  if (!value || typeof value !== 'object') {
    return { kind: 'system' }
  }
  const candidate = value as { kind?: unknown; path?: unknown }
  if (candidate.kind === 'system') {
    return { kind: 'system' }
  }
  if (candidate.kind === 'custom' && typeof candidate.path === 'string') {
    const path = candidate.path.trim()
    if (path) {
      return { kind: 'custom', path }
    }
  }
  // Persisted experimental "managed" values migrate to the stock PATH binary.
  return { kind: 'system' }
}

export type TerminalBackendActivation =
  | { backend: TerminalBackend; state: 'ready' }
  | {
      backend: TerminalBackend
      state: 'migrating'
      migrationId: string
      target: TerminalBackend
      phase: 'preparing' | 'committing'
    }

export type TerminalBackendResolution = {
  globalDefault: TerminalBackend
  preference: TerminalBackendPreference
  activation?: TerminalBackendActivation
}

export function resolveTerminalBackend(resolution: TerminalBackendResolution): TerminalBackend {
  if (resolution.activation) {
    return resolution.activation.backend
  }
  return resolution.preference === 'inherit' ? resolution.globalDefault : resolution.preference
}

export function normalizeTerminalBackendActivation(
  value: unknown
): TerminalBackendActivation | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const candidate = value as {
    backend?: unknown
    state?: unknown
    migrationId?: unknown
    target?: unknown
    phase?: unknown
  }
  const backend = normalizeTerminalBackend(candidate.backend)
  if (candidate.state === 'ready') {
    return { backend, state: 'ready' }
  }
  if (candidate.state === 'migrating') {
    if (
      typeof candidate.migrationId === 'string' &&
      candidate.migrationId &&
      (candidate.target === 'orca' || candidate.target === 'herdr') &&
      (candidate.phase === 'preparing' || candidate.phase === 'committing')
    ) {
      return {
        backend,
        state: 'migrating',
        migrationId: candidate.migrationId,
        target: candidate.target,
        phase: candidate.phase
      }
    }
    return null
  }
  return null
}

export function resolveDesiredTerminalBackend(
  resolution: TerminalBackendResolution
): TerminalBackend {
  if (!resolution.activation) {
    return resolution.preference === 'inherit' ? resolution.globalDefault : resolution.preference
  }
  return resolution.preference === 'inherit' ? resolution.activation.backend : resolution.preference
}

export type TerminalBackendChangePlan =
  | { kind: 'unchanged'; backend: TerminalBackend }
  | {
      kind: 'blocked'
      source: 'orca'
      target: 'herdr'
      liveLegacyPtyIds: string[]
    }
  | {
      kind: 'migrate'
      activation: Extract<TerminalBackendActivation, { state: 'migrating' }>
      behavior: 'attach-herdr' | 'detach-herdr'
    }

export function planTerminalBackendChange(args: {
  activation: TerminalBackendActivation
  target: TerminalBackend
  migrationId: string
  liveLegacyPtyIds: string[]
}): TerminalBackendChangePlan {
  const source = args.activation.backend
  if (source === args.target) {
    return { kind: 'unchanged', backend: source }
  }
  if (source === 'orca' && args.liveLegacyPtyIds.length > 0) {
    return {
      kind: 'blocked',
      source,
      target: 'herdr',
      liveLegacyPtyIds: [...args.liveLegacyPtyIds]
    }
  }
  return {
    kind: 'migrate',
    activation: {
      backend: source,
      state: 'migrating',
      migrationId: args.migrationId,
      target: args.target,
      phase: 'preparing'
    },
    behavior: args.target === 'herdr' ? 'attach-herdr' : 'detach-herdr'
  }
}
