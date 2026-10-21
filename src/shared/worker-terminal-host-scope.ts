// ─── The one reader of a durable `host_scope` string ─────────────────────────
// The column was parsed in three places with three different answers: the strict
// scope parser on the process-liveness path, an inline `JSON.parse` in the fleet
// host projection, and a second inline parse in the fleet status index that
// derives the remote connection fence. A WSL-on-local row could read `local` in
// one and remote in another, so the same worker was local for its host label and
// remote for the connection its evidence had to carry.

/** The scopes a current writer emits. Anything else is legacy or malformed. */
export type WorkerTerminalHostScope =
  | { kind: 'local'; hostId: 'local' }
  | { kind: 'wsl'; hostId: 'local'; distro: string }
  | { kind: 'ssh'; targetId: string }

/** Everything the column can hold, including the arms a strict scope rejects. */
export type WorkerTerminalHostScopeRead =
  /** Null or empty: the legacy representation of local and folder-workspace authority. */
  | { kind: 'absent' }
  /** Present and meaningless. Never local — a malformed remote scope must not read as home. */
  | { kind: 'unreadable' }
  | { kind: 'local'; id: string; scope: WorkerTerminalHostScope | null }
  | {
      kind: 'remote'
      id: string
      /** Only a real target id fences a connection; a remote scope may name none. */
      targetId: string | null
      scope: WorkerTerminalHostScope | null
    }

export function readWorkerTerminalHostScope(
  value: string | null | undefined
): WorkerTerminalHostScopeRead {
  if (!value) {
    return { kind: 'absent' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    // Pre-JSON rows were a bare `local:<id>` string.
    return value.startsWith('local:')
      ? { kind: 'local', id: 'local', scope: null }
      : { kind: 'unreadable' }
  }
  if (!parsed || typeof parsed !== 'object') {
    return { kind: 'unreadable' }
  }
  const scope = parsed as Record<string, unknown>
  const hostId = typeof scope.hostId === 'string' ? scope.hostId : null
  const targetId =
    typeof scope.targetId === 'string' && scope.targetId.length > 0 ? scope.targetId : null
  if (scope.kind === 'local') {
    return {
      kind: 'local',
      id: hostId ?? 'local',
      scope: hostId === 'local' ? { kind: 'local', hostId: 'local' } : null
    }
  }
  // A WSL pane runs on this machine; the distro names the guest, not another host, so a
  // stray target id on the row does not make it remote.
  if (scope.kind === 'wsl' && hostId === 'local') {
    const distro = typeof scope.distro === 'string' && scope.distro.length > 0 ? scope.distro : null
    return {
      kind: 'local',
      id: 'local',
      scope: distro ? { kind: 'wsl', hostId: 'local', distro } : null
    }
  }
  if (scope.kind === 'ssh' && targetId) {
    return { kind: 'remote', id: targetId, targetId, scope: { kind: 'ssh', targetId } }
  }
  if (typeof scope.kind === 'string') {
    return { kind: 'remote', id: targetId ?? hostId ?? scope.kind, targetId, scope: null }
  }
  return { kind: 'unreadable' }
}

/** The strict scope, for callers that must act on the exact host kind. */
export function parseWorkerTerminalHostScope(value: string | null): WorkerTerminalHostScope | null {
  const read = readWorkerTerminalHostScope(value)
  return read.kind === 'local' || read.kind === 'remote' ? read.scope : null
}
