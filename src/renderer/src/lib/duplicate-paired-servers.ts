/**
 * Saved servers that are one machine paired twice. Each publishes the same workspaces, so a write to
 * any of them is ambiguous until the user removes one entry.
 */
import { parseExecutionHostId } from '../../../shared/execution-host'
import type { PublicKnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { translate } from '@/i18n/i18n'
import { WORKTREE_REMOVAL_AMBIGUOUS_ERROR } from '@/store/slices/worktrees/listing/worktree-slice-constants'

type DuplicateServerEnvironment = Pick<
  PublicKnownRuntimeEnvironment,
  'id' | 'name' | 'hostKeyFingerprint'
>

type WorkspaceOwnerRow = { id: string; hostId?: string; runtimeOwnerEnvironmentId?: string }

export type DuplicateServerState = {
  runtimeEnvironments?: readonly DuplicateServerEnvironment[]
  worktreesByRepo?: Record<string, readonly WorkspaceOwnerRow[]>
  detectedWorktreesByRepo?: Record<string, { worktrees: readonly WorkspaceOwnerRow[] }>
  folderWorkspaces?: readonly {
    id: string
    executionHostId?: string | null
    connectionId?: string | null
    projectGroupId?: string | null
  }[]
  projectGroups?: readonly { id: string; executionHostId?: string | null }[]
}

export function duplicatePairedServerNames(
  environments: readonly DuplicateServerEnvironment[],
  environmentId: string
): string[] {
  const self = environments.find((environment) => environment.id === environmentId)
  const key = self?.hostKeyFingerprint
  return key
    ? environments
        .filter(
          (environment) =>
            environment.id !== environmentId && environment.hostKeyFingerprint === key
        )
        .map((environment) => environment.name)
    : []
}

type PublisherRow = { hostId?: string | null; runtimeOwnerEnvironmentId?: string }

type Publisher = {
  /** A paired server's id, or a distinct marker for any other host, so it can never match a twin. */
  publisher: string
  /** Where the workspace lives behind the publisher: the server itself, or a target it proxies. */
  place: string
}

function publisherOf(row: PublisherRow): Publisher {
  const host = parseExecutionHostId(row.hostId ?? undefined)
  const environmentId =
    row.runtimeOwnerEnvironmentId ?? (host?.kind === 'runtime' ? host.environmentId : undefined)
  const place = host?.kind === 'runtime' ? 'server' : (row.hostId ?? 'unstamped')
  return environmentId
    ? { publisher: `env:${environmentId}`, place }
    : { publisher: `host:${row.hostId ?? 'unstamped'}`, place }
}

function workspacePublishers(
  state: DuplicateServerState,
  workspaceId: string
): { publishers: Set<string>; places: Set<string> } {
  const publishers = new Set<string>()
  const places = new Set<string>()
  const add = (row: PublisherRow) => {
    const entry = publisherOf(row)
    publishers.add(entry.publisher)
    places.add(entry.place)
  }
  for (const rows of Object.values(state.worktreesByRepo ?? {})) {
    rows.filter((row) => row.id === workspaceId).forEach(add)
  }
  for (const { worktrees } of Object.values(state.detectedWorktreesByRepo ?? {})) {
    worktrees.filter((row) => row.id === workspaceId).forEach(add)
  }
  const scope = parseWorkspaceKey(workspaceId)
  if (scope?.type === 'folder') {
    for (const folder of state.folderWorkspaces ?? []) {
      if (folder.id !== scope.folderWorkspaceId) {
        continue
      }
      // Why the group: an unstamped folder takes its host from its project group.
      const inherited =
        !folder.executionHostId?.trim() && !folder.connectionId?.trim()
          ? (state.projectGroups ?? []).filter((group) => group.id === folder.projectGroupId)
          : []
      if (inherited.length > 0) {
        inherited.forEach((group) => add({ hostId: group.executionHostId }))
      } else {
        add({ hostId: folder.executionHostId })
      }
    }
  }
  return { publishers, places }
}

/** Name twins only if every publisher shares one server host key and one target; removing a twin must actually resolve the ambiguity. */
export function findDuplicatePairedServersForWorkspace(
  state: DuplicateServerState,
  workspaceId: string
): [string, string] | null {
  const { publishers, places } = workspacePublishers(state, workspaceId)
  if (places.size !== 1) {
    return null
  }
  const environments = [...publishers].map((publisher) =>
    (state.runtimeEnvironments ?? []).find((environment) => `env:${environment.id}` === publisher)
  )
  const [first, second] = environments
  const key = first?.hostKeyFingerprint
  if (!first || !second || !key) {
    return null
  }
  return environments.every((environment) => environment?.hostKeyFingerprint === key)
    ? [first.name, second.name]
    : null
}

// Refreshing cannot fix a server paired twice; name that remedy while retaining generic advice for other ambiguity.
export function ambiguousWorkspaceOwnerMessage(
  state: DuplicateServerState,
  workspaceId: string
): string {
  const duplicate = findDuplicatePairedServersForWorkspace(state, workspaceId)
  return duplicate
    ? translate(
        'auto.lib.duplicatePairedServers.ambiguousSameServer',
        '{{value0}} and {{value1}} are the same server paired twice. Remove one in Settings > Remote Orca Servers.',
        { value0: duplicate[0], value1: duplicate[1] }
      )
    : WORKTREE_REMOVAL_AMBIGUOUS_ERROR
}
