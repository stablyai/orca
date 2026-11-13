// Which cloud workspace (sandbox) a sidebar worktree is, and that workspace's number (W-123) and
// link. Numbers and links come from the control plane's list; the worktree mapping comes from this
// desktop: the owner's own hosted runtime (by worktree id) or a teammate's paired runtime
// environment (by host id). A tiny external store so palette rows and headers stay cheap.
import { useSyncExternalStore } from 'react'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import type { CloudWorkspace } from '../../../../shared/cloud-workspaces/cloud-workspaces-wire'

export type CloudWorkspaceIdentity = {
  number: number | null
  link: string | null
  title: string | null
  /** What this account may do with it (PAIRED-ARCHIVE: only its creator archives a sandbox). */
  access?: CloudWorkspace['access']
}

type State = {
  bySandbox: ReadonlyMap<string, CloudWorkspaceIdentity>
  sandboxByWorktree: ReadonlyMap<string, string>
  sandboxByHost: ReadonlyMap<string, string>
}

let state: State = { bySandbox: new Map(), sandboxByWorktree: new Map(), sandboxByHost: new Map() }
const listeners = new Set<() => void>()

function publish(next: State): void {
  state = next
  listeners.forEach((listener) => listener())
}

function sameIdentity(a: CloudWorkspaceIdentity | undefined, b: CloudWorkspaceIdentity): boolean {
  return (
    a !== undefined &&
    a.number === b.number &&
    a.link === b.link &&
    a.title === b.title &&
    a.access === b.access
  )
}

/** Folds a list (or one workspace) the control plane returned into the cache. */
export function rememberCloudWorkspaces(workspaces: readonly CloudWorkspace[]): void {
  let changed = false
  const next = new Map(state.bySandbox)
  for (const w of workspaces) {
    const identity = {
      number: w.number ?? null,
      link: w.link ?? null,
      title: w.title,
      access: w.access
    }
    if (!sameIdentity(next.get(w.id), identity)) {
      next.set(w.id, identity)
      changed = true
    }
  }
  if (changed) {
    publish({ ...state, bySandbox: next })
  }
}

/** Re-reads which local worktrees and runtime hosts are cloud workspaces on this desktop. */
export async function refreshCloudWorktreeBindings(): Promise<void> {
  const api = window.api.cloudWorkspaces
  const [local, bindings] = await Promise.all([
    api.localWorkspaces().catch(() => []),
    api.environmentBindings().catch(() => ({}))
  ])
  const sandboxByWorktree = new Map<string, string>()
  const sandboxByHost = new Map<string, string>()
  for (const entry of local) {
    if (entry.worktreeId) {
      sandboxByWorktree.set(entry.worktreeId, entry.sandboxId)
    }
    if (entry.runtimeEnvironmentId) {
      sandboxByHost.set(toRuntimeExecutionHostId(entry.runtimeEnvironmentId), entry.sandboxId)
    }
  }
  for (const [sandboxId, binding] of Object.entries(bindings)) {
    sandboxByHost.set(toRuntimeExecutionHostId(binding.environmentId), sandboxId)
  }
  const same = (a: ReadonlyMap<string, string>, b: Map<string, string>) =>
    a.size === b.size && [...b].every(([key, value]) => a.get(key) === value)
  if (
    !same(state.sandboxByWorktree, sandboxByWorktree) ||
    !same(state.sandboxByHost, sandboxByHost)
  ) {
    publish({ ...state, sandboxByWorktree, sandboxByHost })
  }
}

export function sandboxIdForWorktree(
  worktree: { id: string; hostId?: string | null },
  current: State = state
): string | null {
  return (
    (worktree.hostId ? current.sandboxByHost.get(worktree.hostId) : undefined) ??
    current.sandboxByWorktree.get(worktree.id) ??
    null
  )
}

export function cloudWorkspaceIdentity(sandboxId: string | null): CloudWorkspaceIdentity | null {
  return sandboxId ? (state.bySandbox.get(sandboxId) ?? null) : null
}

/** W-number of the cloud workspace a worktree belongs to, or null (not cloud, or not known yet). */
export function cloudNumberForWorktree(
  worktree: { id: string; hostId?: string | null },
  current: State = state
): number | null {
  const sandboxId = sandboxIdForWorktree(worktree, current)
  return sandboxId ? (current.bySandbox.get(sandboxId)?.number ?? null) : null
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The whole cache; changes identity only when something in it changed (memo dependency). */
export function useCloudWorkspaceIdentities(): State {
  return useSyncExternalStore(subscribe, () => state)
}

export function useCloudWorkspaceNumber(sandboxId: string | null | undefined): number | null {
  return useSyncExternalStore(subscribe, () =>
    sandboxId ? (state.bySandbox.get(sandboxId)?.number ?? null) : null
  )
}

export function useCloudWorktreeNumber(
  worktree: { id: string; hostId?: string | null } | null | undefined
): number | null {
  return useSyncExternalStore(subscribe, () => (worktree ? cloudNumberForWorktree(worktree) : null))
}

/** Test-only. */
export function resetCloudWorkspaceIdentityForTests(): void {
  state = { bySandbox: new Map(), sandboxByWorktree: new Map(), sandboxByHost: new Map() }
  listeners.clear()
}

/**
 * PAIRED-ARCHIVE: this account's access to the sandbox behind a paired server, or null while the
 * team list hasn't named it (bindings or list not read yet).
 */
export function usePairedCloudAccess(
  environmentId: string | null | undefined
): CloudWorkspace['access'] | null {
  return useSyncExternalStore(subscribe, () => {
    const sandboxId = environmentId
      ? state.sandboxByHost.get(toRuntimeExecutionHostId(environmentId))
      : undefined
    return (sandboxId ? state.bySandbox.get(sandboxId)?.access : undefined) ?? null
  })
}
