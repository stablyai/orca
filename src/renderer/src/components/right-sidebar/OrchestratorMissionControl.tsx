import React, { useEffect, useMemo, useState } from 'react'
import { ExternalLink, GitMerge, Network } from 'lucide-react'
import { useAppStore } from '@/store'
import { AgentStateDot } from '@/components/AgentStateDot'
import { deriveWorktreeAgentDotState } from '@/lib/worktree-agent-dot-state'
import { selectWorktreeAgentActivityText } from '@/lib/worktree-agent-activity-text'
import { deriveOrcastratorDotState } from '@/lib/orcastrator-dot-state'
import {
  selectOrchestrationActivityForTabs,
  selectRunDagForTabs,
  selectSpawnedWorktreeIds
} from '@/lib/orchestrator-mission-control-data'
import { MissionControlTasksSection } from './MissionControlTasksSection'
import { MissionControlSupervisionSummary } from './MissionControlSupervisionSummary'
import { deriveWorkerPrBadge } from '@/lib/orchestrator-worker-pr-badge'
import {
  parseOrchestrateLogOutcomes,
  selectShippedWork,
  type ShippedWorkItem
} from '@/lib/orcastrate-log-shipped-work'
import { buildGithubPrSearchUrl } from '@/lib/github-pr-search-url'
import { matchesShippedBranch } from '@/lib/shipped-branch-pr-match'
import { getHostedReviewCacheKey } from '@/store/slices/hosted-review'
import { buildShippedCardTarget, buildWorkerCardTarget } from '@/lib/mission-control-card-target'
import { joinPath } from '@/lib/path'
import { translate } from '@/i18n/i18n'
import { MissionControlPrReviewCard } from './MissionControlPrReviewCard'
import { PrStatePill } from './MissionControlPrStatePill'
import type { GitHubWorkItem, Repo, Worktree } from '../../../../shared/types'

// Why: a director appends its outcomes to this log in its own worktree, so it
// survives the worker worktrees being removed — the only durable shipped history.
const ORCASTRATE_LOG_RELATIVE_PATH = '.orcastrate/log.jsonl'

// Why: shown in the Source Control panel when a director's worktree is active,
// in place of the publish/PR view a director has no use for. It is the director's
// console: who it is, why there's no branch here, and the worker worktrees it
// spawned (linked via lineage parent) with each worker's live agent state. v1 is
// derived entirely from already-synced store state — no orchestration RPC yet, so
// it shows agent run-state per worker, not (yet) per-worker dispatch state.
export default function OrchestratorMissionControl({
  worktreeId
}: {
  worktreeId: string
}): React.JSX.Element {
  const orchestrators = useAppStore((s) => s.orchestrators)
  const worktreeLineageById = useAppStore((s) => s.worktreeLineageById)
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const tabsByWorktree = useAppStore((s) => s.tabsByWorktree)
  const agentStatusByPaneKey = useAppStore((s) => s.agentStatusByPaneKey)
  const orchestrationActivityByPaneKey = useAppStore((s) => s.orchestrationActivityByPaneKey)
  const orchestrationRunDagByPaneKey = useAppStore((s) => s.orchestrationRunDagByPaneKey)
  const repos = useAppStore((s) => s.repos)
  const settings = useAppStore((s) => s.settings)
  const hostedReviewCache = useAppStore((s) => s.hostedReviewCache)

  const entry = (orchestrators ?? []).find((candidate) => candidate.worktreeId === worktreeId)

  const worktreesById = useMemo(() => {
    const map = new Map<string, Worktree>()
    for (const list of Object.values(worktreesByRepo ?? {})) {
      for (const worktree of list) {
        map.set(worktree.id, worktree)
      }
    }
    return map
  }, [worktreesByRepo])

  const reposById = useMemo(() => {
    const map = new Map<string, Repo>()
    for (const repo of repos ?? []) {
      map.set(repo.id, repo)
    }
    return map
  }, [repos])

  // Why: a shipped branch usually has no live worktree, but if one still exists we
  // pass it so the card's merge/push/publish actions stay functional.
  const worktreeByBranch = useMemo(() => {
    const map = new Map<string, Worktree>()
    for (const worktree of worktreesById.values()) {
      if (worktree.branch) {
        map.set(worktree.branch, worktree)
      }
    }
    return map
  }, [worktreesById])

  // Why: a worker's PR reads identically to the worktree card — compute the cache
  // key the same way and reuse the card's display derivation, so a live worker
  // shows `PR #N · open/merged` while its worktree exists.
  const prBadgeForWorker = (
    worker: Worktree | undefined
  ): ReturnType<typeof deriveWorkerPrBadge> => {
    if (!worker) {
      return null
    }
    const repo = reposById.get(worker.repoId)
    const branch = worker.branch
    const key =
      repo && branch
        ? getHostedReviewCacheKey(
            repo.path,
            branch,
            settings,
            repo.id,
            repo.connectionId,
            repo.executionHostId
          )
        : ''
    const reviewEntry = key ? hostedReviewCache[key] : undefined
    return deriveWorkerPrBadge(
      worker,
      reviewEntry !== undefined ? reviewEntry.data : undefined,
      reviewEntry?.linkedReviewHintKey
    )
  }

  const workerIds = useMemo(
    () =>
      selectSpawnedWorktreeIds(worktreeId, worktreeLineageById ?? {}, (id) =>
        worktreesById.has(id)
      ),
    [worktreeId, worktreeLineageById, worktreesById]
  )

  // Why: read the director's outcome log so its shipped work shows even after the
  // worker worktrees are torn down. Keyed off the director worktree (path +
  // connection) and re-read when the worktree set changes (a teardown is when a
  // new shipped entry is most likely to have landed).
  const directorWorktree = worktreesById.get(worktreeId)
  const directorRepo = directorWorktree ? reposById.get(directorWorktree.repoId) : undefined
  const directorPath = directorWorktree?.path ?? null
  const directorConnectionId = directorRepo?.connectionId ?? undefined
  // Why: the log is committed, so a new director worktree inherits prior
  // sessions' outcomes. Scope Shipped to outcomes logged at/after this
  // director's creation so foreign work doesn't leak in. Absent for worktrees
  // discovered on disk → unscoped (legacy behavior, no createdAt to anchor to).
  const directorCreatedAt = directorWorktree?.createdAt
  const [shippedItems, setShippedItems] = useState<ShippedWorkItem[]>([])
  useEffect(() => {
    if (!directorPath) {
      setShippedItems([])
      return
    }
    let cancelled = false
    const filePath = joinPath(directorPath, ORCASTRATE_LOG_RELATIVE_PATH)
    void window.api.fs
      .readFile({ filePath, connectionId: directorConnectionId })
      .then((result) => {
        if (!cancelled) {
          setShippedItems(parseOrchestrateLogOutcomes(result.content, directorCreatedAt))
        }
      })
      .catch(() => {
        // Why: no log yet (a brand-new director) is the normal case, not an error.
        if (!cancelled) {
          setShippedItems([])
        }
      })
    return () => {
      cancelled = true
    }
  }, [directorPath, directorConnectionId, directorCreatedAt, worktreesByRepo])

  // Why: resolve the director repo's `owner/repo` so a shipped branch can link to
  // its merged PR via GitHub head-ref search — reliable even after the branch is
  // deleted and the review cache is cold. Null for non-GitHub repos (no link).
  const [repoSlug, setRepoSlug] = useState<string | null>(null)
  useEffect(() => {
    const repoPath = directorRepo?.path
    const repoId = directorRepo?.id
    if (!repoPath || !repoId) {
      setRepoSlug(null)
      return
    }
    let cancelled = false
    void window.api.gh
      .repoSlug({ repoPath, repoId })
      .then((result) => {
        if (!cancelled) {
          setRepoSlug(result ? `${result.owner}/${result.repo}` : null)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setRepoSlug(null)
        }
      })
    return () => {
      cancelled = true
    }
  }, [directorRepo?.path, directorRepo?.id])

  // Why: don't double-list a branch that is still a live worker above; the shipped
  // section is for work whose worktree is gone.
  const liveWorkerBranches = useMemo(
    () => new Set(workerIds.map((id) => worktreesById.get(id)?.branch).filter(Boolean)),
    [workerIds, worktreesById]
  )
  const shippedWork = useMemo(
    () => selectShippedWork(shippedItems).filter((item) => !liveWorkerBranches.has(item.name)),
    [shippedItems, liveWorkerBranches]
  )

  // Why: fetch the repo's PRs once and match each shipped branch to its PR by head
  // ref — prefix-agnostic, so a branch renamed on push (`chore/x` → `prefix/chore-x`)
  // still resolves. Avoids reconstructing the push prefix (which depends on
  // git-username resolution we can't see reliably from the renderer). The
  // component is keyed by the director worktree (see SourceControl), so switching
  // directors remounts it and this state resets without an effect.
  const [prItems, setPrItems] = useState<Omit<GitHubWorkItem, 'repoId'>[]>([])
  useEffect(() => {
    const repoPath = directorRepo?.path
    const repoId = directorRepo?.id
    if (!repoPath || !repoId || shippedWork.length === 0) {
      return
    }
    let cancelled = false
    void window.api.gh
      // Why: `state:all` so merged PRs come back — the default is open-only, which
      // is exactly the wrong set for shipped (merged) work.
      .listWorkItems({ repoPath, repoId, query: 'is:pr state:all', limit: 100 })
      .then((result) => {
        if (!cancelled) {
          setPrItems((result.items ?? []).filter((item) => item.type === 'pr'))
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPrItems([])
        }
      })
    return () => {
      cancelled = true
    }
  }, [directorRepo?.path, directorRepo?.id, shippedWork.length])

  // Direct PR link when a matching PR is found; otherwise a GitHub head-ref search
  // as a fallback (e.g. gh not authed). Null when there's nothing to link to.
  const shippedPrLink = (branch: string): { url: string; number?: number } | null => {
    const pr = prItems.find((item) => matchesShippedBranch(item.branchName ?? '', branch))
    if (pr) {
      return { url: pr.url, number: pr.number }
    }
    return repoSlug ? { url: buildGithubPrSearchUrl(repoSlug, branch) } : null
  }

  const directorTabIds = (tabsByWorktree[worktreeId] ?? []).map((tab) => tab.id)
  // Why: prefer the orchestration-aware dot so a director that handed control
  // back still reads as supervising/stalled while its run is live.
  const directorDot = deriveOrcastratorDotState(
    directorTabIds,
    agentStatusByPaneKey,
    orchestrationActivityByPaneKey
  )
  const directorName =
    entry?.projectName ??
    translate('auto.components.right.sidebar.OrchestratorMissionControl.fallback', 'Orcastrator')

  // Why (#7 O2): when this director has a live coordinator run, render its task
  // DAG; otherwise fall back to the lineage/shipped view so a pure-LLM director
  // (no `orchestration.run`) never regresses. Both paths keep the Shipped log.
  const runDag = useMemo(
    () => selectRunDagForTabs(directorTabIds, orchestrationRunDagByPaneKey ?? {}),
    [directorTabIds, orchestrationRunDagByPaneKey]
  )
  const activity = useMemo(
    () => selectOrchestrationActivityForTabs(directorTabIds, orchestrationActivityByPaneKey ?? {}),
    [directorTabIds, orchestrationActivityByPaneKey]
  )

  return (
    <div className="flex h-full flex-col overflow-y-auto scrollbar-sleek">
      <div className="border-b border-border px-3 py-3">
        <div className="flex items-center gap-2">
          <AgentStateDot state={directorDot} size="sm" />
          <Network className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
            {directorName}
          </span>
        </div>
        {runDag && activity ? (
          <MissionControlSupervisionSummary
            stalled={directorDot === 'stalled'}
            activity={activity}
            recipe={runDag.recipe}
          />
        ) : (
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            {translate(
              'auto.components.right.sidebar.OrchestratorMissionControl.summary',
              'Directs worker agents in their own worktrees — it has no branch to publish. Each worker opens its own pull request.'
            )}
          </p>
        )}
      </div>

      {runDag ? (
        <MissionControlTasksSection dag={runDag} />
      ) : (
        <div className="px-2 py-2">
          <div className="flex items-center justify-between px-1 pb-1">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {translate(
                'auto.components.right.sidebar.OrchestratorMissionControl.spawned',
                'Spawned work'
              )}
            </span>
            {workerIds.length > 0 ? (
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {workerIds.length}
              </span>
            ) : null}
          </div>

          {workerIds.length === 0 ? (
            <p className="px-1 py-2 text-xs leading-relaxed text-muted-foreground">
              {translate(
                'auto.components.right.sidebar.OrchestratorMissionControl.empty',
                'No worktrees yet — the director creates them as it plans the work.'
              )}
            </p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {workerIds.map((id) => {
                const worker = worktreesById.get(id)
                if (!worker) {
                  return null
                }
                const tabIds = (tabsByWorktree[id] ?? []).map((tab) => tab.id)
                const dot = deriveWorktreeAgentDotState(tabIds, agentStatusByPaneKey)
                // Why: mirror DashboardAgentRow's live activity line so a worker
                // row shows what its agent is currently doing, not just a dot.
                const activityText = selectWorktreeAgentActivityText(tabIds, agentStatusByPaneKey)
                const prBadge = prBadgeForWorker(worker)
                const prUrl = prBadge?.url
                return (
                  <MissionControlPrReviewCard
                    key={id}
                    target={buildWorkerCardTarget(worker, reposById.get(worker.repoId) ?? null)}
                    headerLeft={
                      <>
                        <AgentStateDot state={dot} size="sm" />
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate">{worker.displayName ?? id}</span>
                          {activityText ? (
                            <span
                              className="truncate text-[11px] leading-snug text-muted-foreground"
                              title={activityText}
                            >
                              {activityText}
                            </span>
                          ) : null}
                        </span>
                      </>
                    }
                    headerRight={
                      prBadge ? (
                        <>
                          {prBadge.state ? <PrStatePill state={prBadge.state} /> : null}
                          {/* Sibling of the expand trigger (not nested) so opening the
                            PR externally stays distinct from expanding the card. */}
                          {prUrl ? (
                            <button
                              type="button"
                              onClick={() => void window.api.shell.openUrl(prUrl)}
                              className="flex items-center gap-1 text-[11px] tabular-nums text-muted-foreground transition-colors hover:text-foreground hover:underline"
                            >
                              {prBadge.label} #{prBadge.number}
                              <ExternalLink className="size-3" aria-hidden />
                            </button>
                          ) : (
                            <span className="flex items-center gap-1 text-[11px] tabular-nums text-muted-foreground">
                              {prBadge.label} #{prBadge.number}
                            </span>
                          )}
                        </>
                      ) : undefined
                    }
                  />
                )
              })}
            </div>
          )}
        </div>
      )}

      {shippedWork.length > 0 ? (
        <div className="border-t border-border px-2 py-2">
          <div className="flex items-center justify-between px-1 pb-1">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {translate(
                'auto.components.right.sidebar.OrchestratorMissionControl.shipped',
                'Shipped'
              )}
            </span>
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {shippedWork.length}
            </span>
          </div>
          <div className="flex flex-col gap-1.5">
            {shippedWork.map((item) => {
              const prLink = shippedPrLink(item.name)
              return (
                <MissionControlPrReviewCard
                  key={item.name}
                  target={buildShippedCardTarget({
                    repo: directorRepo ?? null,
                    branch: item.name,
                    linkedPR: prLink?.number ?? null,
                    liveWorktree: worktreeByBranch.get(item.name) ?? null
                  })}
                  headerLeft={
                    <>
                      <GitMerge className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="min-w-0 flex-1 truncate">{item.name}</span>
                    </>
                  }
                  headerRight={
                    <>
                      <PrStatePill state="merged" />
                      {prLink ? (
                        <button
                          type="button"
                          onClick={() => void window.api.shell.openUrl(prLink.url)}
                          className="flex shrink-0 items-center gap-1 text-[11px] tabular-nums text-muted-foreground transition-colors hover:text-foreground hover:underline"
                        >
                          {prLink.number != null
                            ? translate(
                                'auto.components.right.sidebar.OrchestratorMissionControl.pr_number',
                                'PR #{{value0}}',
                                { value0: prLink.number }
                              )
                            : translate(
                                'auto.components.right.sidebar.OrchestratorMissionControl.view_pr',
                                'View PR'
                              )}
                          <ExternalLink className="size-3" aria-hidden />
                        </button>
                      ) : null}
                    </>
                  }
                />
              )
            })}
          </div>
          <p className="px-1 pt-1.5 text-[11px] leading-snug text-muted-foreground/80">
            {translate(
              'auto.components.right.sidebar.OrchestratorMissionControl.shipped_note',
              'From the director’s log — the worktrees are torn down after merge; each branch is matched to its merged pull request.'
            )}
          </p>
        </div>
      ) : null}
    </div>
  )
}
