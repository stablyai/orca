import { z } from 'zod'
import { parseExecutionHostId } from '../../../shared/execution-host'
import { RUNTIME_CLIENT_RELAY_RUNTIME_CAPABILITY } from '../../../shared/mobile-desktop-relay-contract'
import {
  MOBILE_RELAY_HOST_WORKTREES_METHOD,
  MOBILE_RELAY_HOSTS_LIST_METHOD
} from '../../../shared/mobile-relay-hosts-contract'
import {
  isWslHostRuntimeEnvironment,
  type PublicKnownRuntimeEnvironment
} from '../../../shared/runtime-environments'
import {
  isRuntimeHostContactRevoked,
  lastVerifiedRuntimeStatus,
  type RuntimeEnvironmentStatus
} from '../../../shared/runtime-host-status'

// Another machine's answer: bound how much of it one relaying server can make the sidebar hold.
export const MAX_RELAYED_HOSTS = 50
export const MAX_RELAYED_ROWS_PER_HOST = 200
export const MAX_RELAYED_TEXT_LENGTH = 200
// Ids are dropped rather than cut: a cut id would name another workspace once rows open.
const MAX_RELAYED_ID_LENGTH = 1024

export type RelayedWorkspaceRow = {
  /** The managed server's own worktree id; meaningful only on that server. */
  worktreeId: string
  displayName: string
  branch: string
  repo: string
  workspaceKind: 'git' | 'folder-workspace'
}

export type RelayedRuntimeHost = {
  /** The relaying server's id for this server (`runtime:<id on that server>`); never routable here. */
  hostId: string
  label: string
  /** Null until the relaying server has fetched this server's workspaces once. */
  worktrees: RelayedWorkspaceRow[] | null
}

export type RelayedRuntimeHostOwner = {
  environmentId: string
  /** Rows belong to this pairing; a re-pair under the same id may be another machine. */
  pairingRevision: number
  label: string
} & ({ state: 'listed'; hosts: RelayedRuntimeHost[] } | { state: 'unavailable' })

export type RelayingRuntimeOwner = {
  environmentId: string
  pairingRevision: number
  label: string
  /** Verified over a ready transport now; only then may a read reach it. */
  inContact: boolean
}

type RelayingOwnerState = {
  runtimeEnvironments: readonly PublicKnownRuntimeEnvironment[]
  runtimeStatusByEnvironmentId: ReadonlyMap<string, RuntimeEnvironmentStatus>
}

/** Paired servers that advertised relaying on this pairing's connection; WSL distros connect only for work open here. */
export function relayingRuntimeOwners(state: RelayingOwnerState): RelayingRuntimeOwner[] {
  return state.runtimeEnvironments.flatMap((environment) => {
    if (isWslHostRuntimeEnvironment(environment)) {
      return []
    }
    const pairingRevision = environment.pairingRevision ?? environment.createdAt
    const entry = state.runtimeStatusByEnvironmentId.get(environment.id)
    const snapshot = entry?.snapshot
    // Capabilities are per connection: status from an earlier pairing, a refusal or a disconnect says nothing now.
    if (
      !snapshot ||
      snapshot.pairingRevision !== pairingRevision ||
      isRuntimeHostContactRevoked(entry) ||
      !(lastVerifiedRuntimeStatus(entry)?.capabilities ?? []).includes(
        RUNTIME_CLIENT_RELAY_RUNTIME_CAPABILITY
      )
    ) {
      return []
    }
    return [
      {
        environmentId: environment.id,
        pairingRevision,
        label: environment.name,
        inContact: snapshot.verification === 'verified' && snapshot.transport === 'ready'
      }
    ]
  })
}

const HostsListSchema = z.object({ hosts: z.array(z.unknown()) })

const HostSchema = z.looseObject({
  hostId: z.string().max(MAX_RELAYED_ID_LENGTH),
  label: z.string(),
  relay: z.string()
})

const WorktreesSchema = z.object({ worktrees: z.array(z.unknown()).nullable() })

const WorktreeRowSchema = z.looseObject({
  worktreeId: z.string().min(1).max(MAX_RELAYED_ID_LENGTH),
  displayName: z.string().optional(),
  branch: z.string().optional(),
  repo: z.string().optional(),
  workspaceKind: z.enum(['git', 'folder-workspace']).optional(),
  isArchived: z.boolean().optional()
})

function clip(text: string): string {
  return text.length > MAX_RELAYED_TEXT_LENGTH ? text.slice(0, MAX_RELAYED_TEXT_LENGTH) : text
}

/** The servers a relaying server can relay to now, deduped and capped; null when the answer is malformed. */
export function parseRelayedHosts(result: unknown): Omit<RelayedRuntimeHost, 'worktrees'>[] | null {
  const listed = HostsListSchema.safeParse(result)
  if (!listed.success) {
    return null
  }
  const hosts: Omit<RelayedRuntimeHost, 'worktrees'>[] = []
  const seen = new Set<string>()
  for (const raw of listed.data.hosts) {
    if (hosts.length >= MAX_RELAYED_HOSTS) {
      break
    }
    const host = HostSchema.safeParse(raw)
    // Only servers relayable now; this client could reach none of the rest.
    if (!host.success || host.data.relay !== 'ready' || seen.has(host.data.hostId)) {
      continue
    }
    if (parseExecutionHostId(host.data.hostId)?.kind !== 'runtime') {
      continue
    }
    seen.add(host.data.hostId)
    hosts.push({ hostId: host.data.hostId, label: clip(host.data.label) })
  }
  return hosts
}

/** One server's unarchived workspace rows, deduped and capped; null when unknown or malformed. */
export function parseRelayedWorkspaceRows(result: unknown): RelayedWorkspaceRow[] | null {
  const reply = WorktreesSchema.safeParse(result)
  if (!reply.success || !reply.data.worktrees) {
    return null
  }
  const rows: RelayedWorkspaceRow[] = []
  const seen = new Set<string>()
  for (const raw of reply.data.worktrees) {
    if (rows.length >= MAX_RELAYED_ROWS_PER_HOST) {
      break
    }
    const row = WorktreeRowSchema.safeParse(raw)
    if (!row.success || row.data.isArchived === true || seen.has(row.data.worktreeId)) {
      continue
    }
    seen.add(row.data.worktreeId)
    rows.push({
      worktreeId: row.data.worktreeId,
      displayName: clip(row.data.displayName ?? ''),
      branch: clip(row.data.branch ?? ''),
      repo: clip(row.data.repo ?? ''),
      workspaceKind: row.data.workspaceKind ?? 'git'
    })
  }
  return rows
}

/** Resolves a relaying server's result; rejects on any failure. */
export type RelayedHostsCall = (method: string, params?: unknown) => Promise<unknown>

/** A relaying server's servers and their workspaces; null when the server list itself could not be read. */
export async function readRelayedRuntimeHosts(
  call: RelayedHostsCall
): Promise<RelayedRuntimeHost[] | null> {
  let hosts: Omit<RelayedRuntimeHost, 'worktrees'>[] | null
  try {
    hosts = parseRelayedHosts(await call(MOBILE_RELAY_HOSTS_LIST_METHOD))
  } catch {
    return null
  }
  if (!hosts) {
    return null
  }
  return Promise.all(
    hosts.map(async (host) => ({
      ...host,
      // A failed row read keeps the server listed with unknown workspaces.
      worktrees: await call(MOBILE_RELAY_HOST_WORKTREES_METHOD, { hostId: host.hostId }).then(
        parseRelayedWorkspaceRows,
        () => null
      )
    }))
  )
}
