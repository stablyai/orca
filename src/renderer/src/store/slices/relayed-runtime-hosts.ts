import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import {
  readRelayedRuntimeHosts,
  relayingRuntimeOwners,
  type RelayedRuntimeHost,
  type RelayedRuntimeHostOwner,
  type RelayingRuntimeOwner
} from '@/runtime/relayed-runtime-hosts'

const RELAYED_HOSTS_CALL_TIMEOUT_MS = 15_000

/** Read-only: these rows never enter the workspace catalog, whose actions a relayed server would refuse. */
export type RelayedRuntimeHostsSlice = {
  relayedRuntimeHostOwners: readonly RelayedRuntimeHostOwner[]
  refreshRelayedRuntimeHosts: () => Promise<void>
}

export function relayedRuntimeOwnerKey(owner: {
  environmentId: string
  pairingRevision: number
}): string {
  return `${owner.environmentId}\0${owner.pairingRevision}`
}

/** Owners still relaying on the pairing their rows came from; a re-pair under the same id may be another machine. */
export function selectRelayedRuntimeHostOwners(state: AppState): RelayedRuntimeHostOwner[] {
  if (state.relayedRuntimeHostOwners.length === 0) {
    return []
  }
  const relaying = new Set(relayingRuntimeOwners(state).map(relayedRuntimeOwnerKey))
  return state.relayedRuntimeHostOwners.filter((owner) =>
    relaying.has(relayedRuntimeOwnerKey(owner))
  )
}

function sameHost(a: RelayedRuntimeHost, b: RelayedRuntimeHost): boolean {
  if (a.hostId !== b.hostId || a.label !== b.label) {
    return false
  }
  const rows = b.worktrees
  if (a.worktrees === null || rows === null) {
    return a.worktrees === rows
  }
  return (
    a.worktrees.length === rows.length &&
    a.worktrees.every(
      (row, index) =>
        row.worktreeId === rows[index].worktreeId &&
        row.displayName === rows[index].displayName &&
        row.branch === rows[index].branch &&
        row.repo === rows[index].repo &&
        row.workspaceKind === rows[index].workspaceKind
    )
  )
}

function sameOwner(a: RelayedRuntimeHostOwner, b: RelayedRuntimeHostOwner): boolean {
  if (
    relayedRuntimeOwnerKey(a) !== relayedRuntimeOwnerKey(b) ||
    a.label !== b.label ||
    a.state !== b.state
  ) {
    return false
  }
  if (a.state !== 'listed' || b.state !== 'listed') {
    return true
  }
  const hosts = b.hosts
  return (
    a.hosts.length === hosts.length && a.hosts.every((host, index) => sameHost(host, hosts[index]))
  )
}

function mergeOwner(
  owner: RelayingRuntimeOwner,
  before: RelayedRuntimeHostOwner | undefined,
  asked: boolean,
  hosts: RelayedRuntimeHost[] | null
): RelayedRuntimeHostOwner | null {
  if (!asked) {
    // Out of contact, so not asked: keep what was last read, as the phone does.
    return before ? { ...before, label: owner.label } : null
  }
  if (hosts === null) {
    return before?.state === 'listed'
      ? before
      : {
          environmentId: owner.environmentId,
          pairingRevision: owner.pairingRevision,
          label: owner.label,
          state: 'unavailable'
        }
  }
  const rowsBefore = new Map(
    before?.state === 'listed' ? before.hosts.map((host) => [host.hostId, host.worktrees]) : []
  )
  return {
    environmentId: owner.environmentId,
    pairingRevision: owner.pairingRevision,
    label: owner.label,
    state: 'listed',
    // A failed row read keeps the last rows of that server.
    hosts: hosts.map((host) =>
      host.worktrees === null ? { ...host, worktrees: rowsBefore.get(host.hostId) ?? null } : host
    )
  }
}

/** Keep the last rows through a failed read or lost contact; drop them once the owner stops relaying on that pairing. */
export function mergeRelayedRuntimeHostOwners(
  previous: readonly RelayedRuntimeHostOwner[],
  relaying: readonly RelayingRuntimeOwner[],
  fetched: ReadonlyMap<string, RelayedRuntimeHost[] | null>
): readonly RelayedRuntimeHostOwner[] {
  const previousByKey = new Map(previous.map((owner) => [relayedRuntimeOwnerKey(owner), owner]))
  const next = relaying.flatMap((owner) => {
    const key = relayedRuntimeOwnerKey(owner)
    const before = previousByKey.get(key)
    const merged = mergeOwner(owner, before, fetched.has(key), fetched.get(key) ?? null)
    if (!merged) {
      return []
    }
    // Polls usually change nothing; keep identity so the sidebar section does not re-render.
    return [before && sameOwner(before, merged) ? before : merged]
  })
  return next.length === previous.length && next.every((owner, index) => owner === previous[index])
    ? previous
    : next
}

export const createRelayedRuntimeHostsSlice: StateCreator<
  AppState,
  [],
  [],
  RelayedRuntimeHostsSlice
> = (set, get) => {
  // Only the latest refresh may land: an older, slower one must not overwrite newer rows.
  let generation = 0

  return {
    relayedRuntimeHostOwners: [],

    refreshRelayedRuntimeHosts: async () => {
      const current = ++generation
      const reads = await Promise.all(
        relayingRuntimeOwners(get())
          // Asking a server out of contact would wake it, or restart a managed one, every poll.
          .filter((owner) => owner.inContact)
          .map(async (owner) => {
            const hosts = await readRelayedRuntimeHosts((method, params) =>
              callRuntimeRpc(
                { kind: 'environment', environmentId: owner.environmentId },
                method,
                params,
                {
                  timeoutMs: RELAYED_HOSTS_CALL_TIMEOUT_MS,
                  // This pairing's verified status already advertised the relay capability.
                  skipCompatibilityCheck: true,
                  expectedEnvironmentPairingRevision: owner.pairingRevision
                }
              )
            )
            return [relayedRuntimeOwnerKey(owner), hosts] as const
          })
      )
      if (current !== generation) {
        return
      }
      // Recheck after the reads: an unpair, re-pair or downgrade during them must not bring rows back.
      const relaying = relayingRuntimeOwners(get())
      set((state) => {
        const next = mergeRelayedRuntimeHostOwners(
          state.relayedRuntimeHostOwners,
          relaying,
          new Map(reads)
        )
        return next === state.relayedRuntimeHostOwners ? state : { relayedRuntimeHostOwners: next }
      })
    }
  }
}
