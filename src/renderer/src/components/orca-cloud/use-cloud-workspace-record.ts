import { useCallback, useEffect, useSyncExternalStore } from 'react'
import type { CloudWorkspace } from '../../../../shared/cloud-workspaces/cloud-workspaces-wire'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'

/**
 * The team's record of the cloud workspace behind a sidebar row (visibility, access), so the
 * sidebar menu can offer the same Share actions as Home. Owned workspaces are found through this
 * desktop's runtime; paired ones through their pairing.
 *
 * Kept per row across menu openings (last known), and fetched before the menu opens (row hover),
 * so the menu's rows are there on its first paint instead of appearing a second later. A record
 * older than RECORD_FRESH_MS is shown and refreshed in the background.
 */
export const RECORD_FRESH_MS = 30_000

type Entry = { workspace: CloudWorkspace | null; at: number }

const records = new Map<string, Entry>()
const inFlight = new Map<string, Promise<void>>()
const listeners = new Set<() => void>()

function key(worktreeId: string, hostId: string | null | undefined): string {
  return `${worktreeId}\0${hostId ?? ''}`
}

function api(): NonNullable<Window['api']>['cloudWorkspaces'] | undefined {
  return typeof window !== 'undefined' ? window.api?.cloudWorkspaces : undefined
}

function fetchRecord(worktreeId: string, hostId: string | null | undefined): Promise<void> {
  const bridge = api()
  const k = key(worktreeId, hostId)
  if (!bridge) {
    return Promise.resolve()
  }
  const running = inFlight.get(k)
  if (running) {
    return running
  }
  const run = (async () => {
    const sandboxId = await resolveSandboxId(bridge, worktreeId, hostId)
    const result = sandboxId ? await bridge.get(sandboxId).catch(() => null) : null
    records.set(k, { workspace: result?.ok ? result.value : null, at: Date.now() })
    for (const listener of listeners) {
      listener()
    }
  })().finally(() => inFlight.delete(k))
  inFlight.set(k, run)
  return run
}

/** Loads the record unless a fresh one is known; for row hover, before any menu opens. */
export function prefetchCloudWorkspaceRecord(
  worktreeId: string,
  hostId: string | null | undefined,
  now = Date.now()
): void {
  const known = records.get(key(worktreeId, hostId))
  if (!known || now - known.at >= RECORD_FRESH_MS) {
    void fetchRecord(worktreeId, hostId)
  }
}

/**
 * `workspace`: the last known record, null when there is none. `loaded`: false only until the
 * first answer for this row, the one time a caller can't yet tell "none" from "not asked".
 */
export function useCloudWorkspaceRecord(
  worktreeId: string,
  hostId: string | null | undefined
): { workspace: CloudWorkspace | null; loaded: boolean; reload: () => void } {
  const entry = useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => records.get(key(worktreeId, hostId))
  )
  useEffect(() => {
    prefetchCloudWorkspaceRecord(worktreeId, hostId)
  }, [worktreeId, hostId])
  const reload = useCallback(() => void fetchRecord(worktreeId, hostId), [worktreeId, hostId])
  return { workspace: entry?.workspace ?? null, loaded: entry !== undefined, reload }
}

/** Tests: forget every record. */
export function resetCloudWorkspaceRecordsForTests(): void {
  records.clear()
  inFlight.clear()
}

async function resolveSandboxId(
  api: NonNullable<Window['api']>['cloudWorkspaces'],
  worktreeId: string,
  hostId: string | null | undefined
): Promise<string | null> {
  const local = (await api.localWorkspaces().catch(() => [])).find(
    (entry) => entry.worktreeId === worktreeId
  )
  if (local) {
    return local.sandboxId
  }
  if (!hostId) {
    return null
  }
  const bindings = await api.environmentBindings().catch(() => ({}))
  for (const [sandboxId, binding] of Object.entries(bindings)) {
    if (toRuntimeExecutionHostId(binding.environmentId) === hostId) {
      return sandboxId
    }
  }
  return null
}
