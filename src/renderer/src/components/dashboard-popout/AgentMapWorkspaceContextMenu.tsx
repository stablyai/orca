import { Suspense, useEffect, useMemo, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { lazyWithRetry } from '@/lib/lazy-with-retry'
import { useAppStore } from '@/store'
import { useWorktreeById } from '@/store/selectors'
import type { AppState } from '@/store/types'
import {
  getRepoExecutionHostId,
  normalizeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'

const WorktreeContextMenu = lazyWithRetry(
  () => import('@/components/sidebar/WorktreeContextMenu'),
  { reloadKey: 'agent-map-worktree-context-menu' }
)

export type AgentMapWorkspaceContextMenuRequest = {
  id: number
  worktreeId: string
  executionHostId?: ExecutionHostId
  clientX: number
  clientY: number
  altKey: boolean
}

type AgentMapWorkspaceContextMenuProps = {
  request: AgentMapWorkspaceContextMenuRequest | null
  onOpenChange?: (open: boolean) => void
  onLifecycleComplete?: () => void
}

function countWorkspaceOwners(
  worktreeId: string | null,
  state: Pick<
    AppState,
    'worktreesByRepo' | 'detectedWorktreesByRepo' | 'folderWorkspaces' | 'repos'
  >
): number {
  if (!worktreeId) {
    return 0
  }
  const scope = parseWorkspaceKey(worktreeId)
  if (scope?.type === 'folder') {
    return new Set(
      state.folderWorkspaces
        .filter((workspace) => workspace.id === scope.folderWorkspaceId)
        .map(
          (workspace) =>
            normalizeExecutionHostId(workspace.executionHostId) ??
            (workspace.connectionId ? toSshExecutionHostId(workspace.connectionId) : 'local')
        )
    ).size
  }
  const repoOwnerIdsByRepoId = new Map<string, Set<ExecutionHostId>>()
  for (const repo of state.repos) {
    const ownerId = getRepoExecutionHostId(repo)
    const owners = repoOwnerIdsByRepoId.get(repo.id)
    if (owners) {
      owners.add(ownerId)
    } else {
      repoOwnerIdsByRepoId.set(repo.id, new Set([ownerId]))
    }
  }
  const ownerIds = new Set<ExecutionHostId>()
  const addOwner = (worktree: { repoId: string; hostId?: ExecutionHostId }): void => {
    const directOwner = normalizeExecutionHostId(worktree.hostId)
    if (directOwner) {
      ownerIds.add(directOwner)
      return
    }
    const repoOwnerIds = repoOwnerIdsByRepoId.get(worktree.repoId)
    if (!repoOwnerIds) {
      ownerIds.add('local')
      return
    }
    for (const ownerId of repoOwnerIds) {
      ownerIds.add(ownerId)
    }
  }
  for (const worktrees of Object.values(state.worktreesByRepo)) {
    for (const worktree of worktrees) {
      if (worktree.id === worktreeId) {
        addOwner(worktree)
      }
    }
  }
  for (const result of Object.values(state.detectedWorktreesByRepo)) {
    for (const worktree of result.worktrees) {
      if (worktree.id === worktreeId) {
        addOwner(worktree)
      }
    }
  }
  return ownerIds.size
}

function ContextMenuTrigger({
  request
}: {
  request: AgentMapWorkspaceContextMenuRequest
}): React.JSX.Element {
  const triggerRef = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    triggerRef.current?.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: request.clientX,
        clientY: request.clientY,
        altKey: request.altKey,
        button: 2
      })
    )
  }, [request])
  return <span ref={triggerRef} aria-hidden />
}

export function AgentMapWorkspaceContextMenu({
  request,
  onOpenChange,
  onLifecycleComplete
}: AgentMapWorkspaceContextMenuProps): React.JSX.Element | null {
  const { worktreesByRepo, detectedWorktreesByRepo, folderWorkspaces, repos } = useAppStore(
    useShallow((state) => ({
      worktreesByRepo: state.worktreesByRepo,
      detectedWorktreesByRepo: state.detectedWorktreesByRepo,
      folderWorkspaces: state.folderWorkspaces,
      repos: state.repos
    }))
  )
  const worktree = useWorktreeById(request?.worktreeId ?? null, request?.executionHostId)
  const ownerCount = useMemo(
    () =>
      countWorkspaceOwners(request?.worktreeId ?? null, {
        worktreesByRepo,
        detectedWorktreesByRepo,
        folderWorkspaces,
        repos
      }),
    [detectedWorktreesByRepo, folderWorkspaces, repos, request?.worktreeId, worktreesByRepo]
  )
  const unavailable = request !== null && (!worktree || ownerCount !== 1)
  useEffect(() => {
    if (unavailable) {
      onLifecycleComplete?.()
    }
  }, [onLifecycleComplete, unavailable])
  if (!request || unavailable || !worktree) {
    return null
  }
  return (
    <div className="pointer-events-none absolute inset-0">
      <Suspense fallback={null}>
        <WorktreeContextMenu
          worktree={worktree}
          onOpenChange={onOpenChange}
          onLifecycleComplete={onLifecycleComplete}
        >
          <ContextMenuTrigger request={request} />
        </WorktreeContextMenu>
      </Suspense>
    </div>
  )
}
