export type TerminalBackend = 'orca' | 'herdr'

export type TerminalBackendPreference = 'inherit' | TerminalBackend

export type HerdrBinarySource =
  | { kind: 'managed' }
  | { kind: 'system' }
  | { kind: 'custom'; path: string }

export function normalizeTerminalBackend(value: unknown): TerminalBackend {
  return value === 'herdr' ? 'herdr' : 'orca'
}

export function normalizeHerdrBinarySource(value: unknown): HerdrBinarySource {
  if (!value || typeof value !== 'object') {
    return { kind: 'managed' }
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
  return { kind: 'managed' }
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
