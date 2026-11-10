import { resolveOwner } from '@/lib/workspace/ownership/resolve-owner'
import { useAppStore } from '@/store/index'
import {
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../../shared/execution-host'
import { slugifyForWorkspaceName } from '../../../../../shared/workspace-name'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../shared/constants'
import type { WorkspaceSource } from '../../../../../shared/workspace-source'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'

/** A fork's name: its source's, marked as a fork. */
export function forkWorkspaceName(sourceName: string): string {
  return slugifyForWorkspaceName(`${sourceName}-fork`) || 'session-fork'
}

/** The source's branch when it is a git worktree a fork can branch from; null otherwise. */
export function forkableWorktreeBranch(
  worktree:
    | { branch?: string | null; isArchived?: boolean; isBare?: boolean; repoId?: string }
    | null
    | undefined,
  repo: { kind?: string } | null | undefined,
  worktreeId: string
): string | null {
  const branch = worktree?.branch?.trim()
  if (
    worktreeId === FLOATING_TERMINAL_WORKTREE_ID ||
    !branch ||
    worktree?.isArchived ||
    worktree?.isBare ||
    !repo ||
    repo.kind === 'folder'
  ) {
    return null
  }
  return branch
}

/** The transport that owns the source: its server, else where this app reaches it (local or SSH). */
export function forkCreationHostId(
  state: Parameters<typeof resolveOwner>[0],
  worktreeId: string
): ExecutionHostId | undefined {
  const owner = resolveOwner(state, { workspaceId: worktreeId })
  if (owner.kind !== 'resolved') {
    return undefined
  }
  const { endpoint, at } = owner.owner
  return endpoint.kind === 'environment' ? toRuntimeExecutionHostId(endpoint.environmentId) : at
}

type CreatedForkWorktree = Awaited<
  ReturnType<ReturnType<typeof useAppStore.getState>['createWorktree']>
>['worktree']

/** Creates a sibling worktree for a fork on its source's host; throws what creation threw.
 *  Without `baseBranch` the new branch starts from the project's default base. */
export async function createForkWorktree(input: {
  sourceWorktreeId: string
  repoId: string
  /** Names the fork; its display name also leads with the source's own display name when set. */
  sourceName: string
  sourceDisplayName?: string
  baseBranch?: string
  agent?: TuiAgent
  source: WorkspaceSource
}): Promise<CreatedForkWorktree> {
  const store = useAppStore.getState()
  const name = forkWorkspaceName(input.sourceName)
  const created = await store.createWorktree(
    input.repoId,
    name,
    input.baseBranch,
    'inherit',
    undefined,
    input.source,
    `Fork of ${input.sourceDisplayName || name}`,
    undefined,
    undefined,
    undefined,
    input.agent,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    // Why: a project two hosts publish refuses a host-less create; the fork belongs on its source's host.
    { executionHostId: forkCreationHostId(store, input.sourceWorktreeId) }
  )
  return created.worktree
}
