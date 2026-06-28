import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { getAttachedWorktreesForFolderWorkspace } from './folder-workspace-attached-worktrees'
import { FolderWorkspaceSourceControlSection } from './folder-workspace-source-control-section'
import {
  getFolderSourceControlRefreshCandidates,
  invalidateFolderSourceControlRefreshGeneration,
  resolveFolderSourceControlRepo,
  runLimitedFolderSourceControlRefreshes,
  type FolderSourceControlRefreshReservations,
  type FolderSourceControlRefreshOutcome
} from './folder-workspace-source-control-refresh'

export default function FolderWorkspaceSourceControlPanel(): React.JSX.Element {
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const activeWorkspaceKey = useAppStore((s) => s.activeWorkspaceKey)
  const folderWorkspaces = useAppStore((s) => s.folderWorkspaces)
  const workspaceLineageByChildKey = useAppStore((s) => s.workspaceLineageByChildKey)
  const worktreeLineageById = useAppStore((s) => s.worktreeLineageById)
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const repos = useAppStore((s) => s.repos)
  const gitStatusByWorktree = useAppStore((s) => s.gitStatusByWorktree)
  const sshConnectionStates = useAppStore((s) => s.sshConnectionStates)
  const setGitStatus = useAppStore((s) => s.setGitStatus)
  const updateWorktreeGitIdentity = useAppStore((s) => s.updateWorktreeGitIdentity)
  const setUpstreamStatus = useAppStore((s) => s.setUpstreamStatus)
  const fetchUpstreamStatus = useAppStore((s) => s.fetchUpstreamStatus)
  const [expandedWorktreeIds, setExpandedWorktreeIds] = useState<ReadonlySet<string>>(
    () => new Set()
  )
  const [refreshOutcomes, setRefreshOutcomes] = useState<
    ReadonlyMap<string, FolderSourceControlRefreshOutcome>
  >(() => new Map())
  const [manualRefreshGeneration, setManualRefreshGeneration] = useState(0)
  const lastManualGenerationRef = useRef(0)
  const inFlightRefreshWorktreeIdsRef = useRef<FolderSourceControlRefreshReservations>(new Map())
  const refreshGenerationByWorktreeRef = useRef<Map<string, number>>(new Map())

  const { folderWorkspace, childWorktrees } = useMemo(
    () =>
      getAttachedWorktreesForFolderWorkspace({
        activeWorkspaceKey,
        activeWorktreeId,
        folderWorkspaces,
        workspaceLineageByChildKey,
        worktreeLineageById,
        worktreesByRepo
      }),
    [
      activeWorkspaceKey,
      activeWorktreeId,
      folderWorkspaces,
      workspaceLineageByChildKey,
      worktreeLineageById,
      worktreesByRepo
    ]
  )

  useEffect(() => {
    setExpandedWorktreeIds((current) => {
      const validIds = new Set(childWorktrees.map((worktree) => worktree.id))
      const next = new Set([...current].filter((id) => validIds.has(id)))
      if (next.size === 0 && childWorktrees[0]) {
        next.add(childWorktrees[0].id)
      }
      return setsEqual(current, next) ? current : next
    })
  }, [childWorktrees])

  const manualWorktreeIds = useMemo(() => {
    if (manualRefreshGeneration <= lastManualGenerationRef.current) {
      return new Set<string>()
    }
    return new Set(childWorktrees.map((worktree) => worktree.id))
  }, [childWorktrees, manualRefreshGeneration])

  const refreshCandidates = useMemo(
    () =>
      getFolderSourceControlRefreshCandidates({
        worktrees: childWorktrees,
        repos,
        expandedWorktreeIds,
        manualWorktreeIds
      }),
    [childWorktrees, expandedWorktreeIds, manualWorktreeIds, repos]
  )
  const refreshCandidateSignature = useMemo(
    () =>
      refreshCandidates
        .map((candidate) =>
          [
            candidate.worktree.id,
            candidate.worktree.path,
            candidate.repo.connectionId ?? '',
            candidate.repo.executionHostId ?? '',
            candidate.expanded ? 'expanded' : 'collapsed',
            candidate.manual ? 'manual' : 'auto'
          ].join('|')
        )
        .join(';;'),
    [refreshCandidates]
  )

  useEffect(() => {
    if (!folderWorkspace || childWorktrees.length === 0 || refreshCandidates.length === 0) {
      return
    }
    const refreshWorktreeIds = refreshCandidates.map((candidate) => candidate.worktree.id)
    const refreshGenerations = refreshGenerationByWorktreeRef.current
    const inFlightRefreshes = inFlightRefreshWorktreeIdsRef.current
    if (manualRefreshGeneration > lastManualGenerationRef.current) {
      lastManualGenerationRef.current = manualRefreshGeneration
    }
    let cancelled = false
    void runLimitedFolderSourceControlRefreshes({
      candidates: refreshCandidates,
      concurrency: 3,
      deps: {
        setGitStatus,
        updateWorktreeGitIdentity,
        setUpstreamStatus,
        fetchUpstreamStatus
      },
      sshConnectionStates,
      inFlightWorktreeIds: inFlightRefreshes,
      refreshGenerationByWorktree: refreshGenerations,
      onOutcome: (worktreeId, outcome) => {
        if (cancelled) {
          return
        }
        setRefreshOutcomes((current) => new Map(current).set(worktreeId, outcome))
      }
    })
    return () => {
      cancelled = true
      invalidateFolderSourceControlRefreshGeneration(refreshGenerations, refreshWorktreeIds)
      for (const worktreeId of refreshWorktreeIds) {
        inFlightRefreshes.delete(worktreeId)
      }
    }
  }, [
    childWorktrees.length,
    fetchUpstreamStatus,
    folderWorkspace,
    manualRefreshGeneration,
    refreshCandidateSignature,
    refreshCandidates,
    setGitStatus,
    setUpstreamStatus,
    sshConnectionStates,
    updateWorktreeGitIdentity
  ])

  const currentChildWorktreeIds = useMemo(
    () => new Set(childWorktrees.map((worktree) => worktree.id)),
    [childWorktrees]
  )
  const isRefreshing = [...refreshOutcomes.entries()].some(
    ([worktreeId, outcome]) => currentChildWorktreeIds.has(worktreeId) && outcome.kind === 'loading'
  )
  const repoNameByWorktreeId = useMemo(
    () =>
      new Map(
        childWorktrees.map((worktree) => [
          worktree.id,
          resolveFolderSourceControlRepo(worktree, repos)?.displayName ?? null
        ])
      ),
    [childWorktrees, repos]
  )

  const toggleWorktree = useCallback((worktreeId: string): void => {
    setExpandedWorktreeIds((current) => {
      const next = new Set(current)
      if (next.has(worktreeId)) {
        next.delete(worktreeId)
      } else {
        next.add(worktreeId)
      }
      return next
    })
  }, [])

  if (!folderWorkspace) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
        {translate(
          'auto.components.rightSidebar.FolderWorkspaceSourceControlPanel.unavailable',
          'Source Control is only shown for folder workspaces with attached worktrees.'
        )}
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-foreground">
              {folderWorkspace.name}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              {formatAttachedWorktreeCount(childWorktrees.length)}
            </div>
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={() => setManualRefreshGeneration((generation) => generation + 1)}
                disabled={childWorktrees.length === 0 || isRefreshing}
                aria-label={translate(
                  'auto.components.rightSidebar.FolderWorkspaceSourceControlPanel.refresh',
                  'Refresh source control'
                )}
              >
                <RefreshCw className={cn('size-3.5', isRefreshing && 'animate-spin')} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {translate(
                'auto.components.rightSidebar.FolderWorkspaceSourceControlPanel.refresh',
                'Refresh source control'
              )}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      {childWorktrees.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
          <div className="text-sm font-medium text-foreground">
            {translate(
              'auto.components.rightSidebar.FolderWorkspaceSourceControlPanel.emptyTitle',
              'No attached worktrees yet'
            )}
          </div>
          <div className="mt-2 max-w-[16rem] text-xs leading-5 text-muted-foreground">
            {translate(
              'auto.components.rightSidebar.FolderWorkspaceSourceControlPanel.emptyCopy',
              'Source Control sections will appear here after worktrees are attached to this folder workspace.'
            )}
          </div>
        </div>
      ) : (
        <div className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto px-2 py-2">
          <div className="space-y-1">
            {childWorktrees.map((worktree) => {
              const expanded = expandedWorktreeIds.has(worktree.id)
              return (
                <FolderWorkspaceSourceControlSection
                  key={worktree.id}
                  worktree={worktree}
                  repoName={repoNameByWorktreeId.get(worktree.id) ?? null}
                  expanded={expanded}
                  statusEntries={gitStatusByWorktree[worktree.id]}
                  refreshOutcome={refreshOutcomes.get(worktree.id) ?? null}
                  onToggle={() => toggleWorktree(worktree.id)}
                />
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

function formatAttachedWorktreeCount(count: number): string {
  return count === 1
    ? translate(
        'auto.components.rightSidebar.FolderWorkspaceSourceControlPanel.countOne',
        '1 attached worktree'
      )
    : translate(
        'auto.components.rightSidebar.FolderWorkspaceSourceControlPanel.countMany',
        '{{value0}} attached worktrees',
        { value0: count }
      )
}

function setsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) {
    return false
  }
  for (const value of left) {
    if (!right.has(value)) {
      return false
    }
  }
  return true
}
