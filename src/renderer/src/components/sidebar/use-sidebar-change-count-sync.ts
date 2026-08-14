import { useEffect, useRef } from 'react'
import { useAppStore } from '@/store'
import { getConnectionId } from '@/lib/connection-context'
import {
  getExplicitRuntimeEnvironmentIdForWorktree,
  type WorktreeRuntimeOwnerState
} from '@/lib/worktree-runtime-owner'
import { installWindowVisibilityInterval, isWindowVisible } from '@/lib/window-visibility-interval'
import { isFolderRepo } from '../../../../shared/repo-kind'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  refreshGitStatusForWorktree,
  type GitStatusRefreshDeps
} from '../right-sidebar/git-status-refresh'
import { getVisibleWorktreeIds } from './visible-worktrees'

// Why: the sidebar summary is glanceable context, not the panel the user is
// reading, so it polls on the slow branch cadence rather than the status one.
const SIDEBAR_CHANGE_COUNT_POLL_INTERVAL_MS = 30_000
// Why: every workspace costs one `git status`, which is a subprocess locally and
// a round trip over SSH. A small window keeps a large project list from
// stampeding the host while still finishing a sweep well inside one interval.
const MAX_CONCURRENT_SWEEP_REQUESTS = 4
// Why: a build or a branch switch writes hundreds of files at once, and several
// agents can finish within the same second. Without a quiet period each one would
// spawn its own sweep -- the failure mode VS Code's git extension is repeatedly
// reported for.
const EVENT_QUIET_PERIOD_MS = 400
// Why proportional to how long the last sweep took, rather than a fixed floor: a
// fixed floor either makes the cheap common case feel sluggish or fails to bound
// the expensive one -- once a sweep outlasts the floor, the elapsed time already
// exceeds it and sweeps chain back to back. Two parts idle per part working caps
// the duty cycle near a third whatever a sweep costs on this machine and host.
const EVENT_SWEEP_IDLE_MULTIPLIER = 2

const NO_UPSTREAM_WRITE: GitStatusRefreshDeps['setUpstreamStatus'] = () => {}
const NO_UPSTREAM_FETCH: GitStatusRefreshDeps['fetchUpstreamStatus'] = async () => null

const EMPTY_REPOS: Repo[] = []
const EMPTY_WORKTREES_BY_REPO: Record<string, Worktree[]> = {}

type PollInputs = {
  repos: readonly Repo[]
  worktreesByRepo: Record<string, Worktree[]>
  settings: WorktreeRuntimeOwnerState['settings']
  deps: GitStatusRefreshDeps
}

/**
 * Keeps `gitStatusByWorktree` warm for every Git workspace listed in the
 * sidebar, so each row can show its uncommitted-change count without being
 * opened.
 */
export function useSidebarChangeCountSync({ enabled }: { enabled: boolean }): void {
  const repos = useAppStore((s) => s.repos) ?? EMPTY_REPOS
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo) ?? EMPTY_WORKTREES_BY_REPO
  const settings = useAppStore((s) => s.settings)
  const setGitStatus = useAppStore((s) => s.setGitStatus)
  const updateWorktreeGitIdentity = useAppStore((s) => s.updateWorktreeGitIdentity)
  // Why: agents are the main writer to workspaces the user is not looking at, so
  // an agent going live or finishing is the strongest available signal that some
  // project's tree just changed. The epoch moves on any liveness change.
  const agentStatusEpoch = useAppStore((s) => s.agentStatusEpoch) ?? 0
  const requestEventSweepRef = useRef<() => void>(() => {})
  const lastSeenAgentEpochRef = useRef<number | null>(null)

  // Why: everything the sweep needs comes through this ref, so the effect below
  // depends only on `enabled`. Re-running it aborts in-flight `git status`
  // calls, which silently drops whichever workspaces the sweep had not reached.
  const inputs: PollInputs = {
    repos,
    worktreesByRepo,
    settings,
    // Why the sweep writes no upstream state: the count needs none of it, and
    // porcelain reports Git's *configured* upstream -- the wrong answer for a
    // PR-created workspace whose publish target is Orca's own. Writing it would
    // clobber the panel's correct comparison and flip its primary action to
    // "Publish Branch" on a branch that is already published. Branch identity is
    // still worth taking: rows display it.
    deps: {
      setGitStatus,
      updateWorktreeGitIdentity,
      setUpstreamStatus: NO_UPSTREAM_WRITE,
      fetchUpstreamStatus: NO_UPSTREAM_FETCH
    }
  }
  const inputsRef = useRef<PollInputs>(inputs)
  // Why assigned during render and not in an effect: the sweep reads this from
  // timers, filesystem events and agent transitions, which fire at any moment. An
  // effect would leave a window between render and commit where the ref still
  // holds the previous workspace list, and an event landing there would sweep the
  // wrong set. Writing during render is a render side effect, but a discarded
  // render only leaves fresher values behind -- never an inconsistent pair.
  inputsRef.current = inputs

  useEffect(() => {
    if (!enabled) {
      return
    }
    const controller = new AbortController()
    let sweepInFlight = false
    let sweepRequestedWhileRunning = false
    let lastSweepEndedAt = 0
    let lastSweepDurationMs = 0

    const collectTargets = (): Worktree[] => {
      const inputs = inputsRef.current
      const gitRepoIds = new Set(
        inputs.repos.filter((repo) => !isFolderRepo(repo)).map((repo) => repo.id)
      )
      // Why the rendered set rather than every known workspace: a count only
      // matters where a row exists to carry it. The sidebar also drops archived,
      // default-branch, automation- and CLI-created and detached-head workspaces
      // and applies the repo and host filters; restating that here would drift
      // from it. Cost: a workspace hidden by a transient filter keeps a stale
      // count until the first tick after it reappears.
      const visibleIds = new Set(getVisibleWorktreeIds())
      const targets: Worktree[] = []
      for (const worktrees of Object.values(inputs.worktreesByRepo)) {
        for (const worktree of worktrees) {
          // Folder workspaces have no Git status to summarize. The ACTIVE
          // workspace is deliberately kept: Source Control only polls it while
          // the right sidebar shows that tab, so skipping it here would leave the
          // selected row -- the one most likely being looked at -- blank.
          if (!gitRepoIds.has(worktree.repoId) || !visibleIds.has(worktree.id)) {
            continue
          }
          targets.push(worktree)
        }
      }
      return targets
    }

    const refreshTarget = async (worktree: Worktree): Promise<void> => {
      const inputs = inputsRef.current
      const repo = inputs.repos.find((candidate) => candidate.id === worktree.repoId)
      // Why: the type says these exist, but a partial store mock can still hand
      // back undefined -- this guards the mock, not a hole in the typing.
      if (!repo || typeof inputs.deps.setGitStatus !== 'function') {
        return
      }
      const connectionId = getConnectionId(worktree.id) ?? undefined
      try {
        await refreshGitStatusForWorktree({
          // Why the EXPLICIT owner of this workspace, not the repo's routed
          // owner: the repo helper falls back to the globally focused runtime for
          // a repo with no explicit host, which dispatches a local workspace's
          // status to a runtime that does not know it (#6957). A background read
          // wants "the host that owns this, or local" and nothing else.
          settings: {
            activeRuntimeEnvironmentId: getExplicitRuntimeEnvironmentIdForWorktree(
              {
                repos: inputs.repos,
                settings: inputs.settings,
                worktreesByRepo: inputs.worktreesByRepo
              },
              worktree.id
            )
          },
          worktreeId: worktree.id,
          worktreePath: worktree.path,
          ...(connectionId ? { connectionId } : {}),
          deps: inputs.deps,
          request: {
            // Why: line counts cost extra `git diff --numstat` spawns and a read of
            // every changed untracked file, and neither the row count nor the hover
            // breakdown displays them. The panel's idle poll reuses them too.
            reuseLineStats: true,
            signal: controller.signal,
            shouldApply: () => !controller.signal.aborted
          }
        })
      } catch {
        // A workspace that cannot report status keeps its previous count.
      }
    }

    const sweep = async (): Promise<void> => {
      if (controller.signal.aborted) {
        return
      }
      // Why here and not only in the interval: the event paths call sweep()
      // directly, so a hidden window would still fan out a `git status` per
      // workspace for a sidebar nobody can see. A skipped run is not lost --
      // becoming visible again triggers a catch-up sweep.
      if (!isWindowVisible()) {
        return
      }
      // Why: a sweep slower than the interval must not stack another one on top
      // and double every workspace's Git load -- but dropping the request would
      // lose whatever prompted it until the next tick, so remember it instead.
      if (sweepInFlight) {
        sweepRequestedWhileRunning = true
        return
      }
      sweepInFlight = true
      const startedAt = Date.now()
      try {
        const targets = collectTargets()
        let nextIndex = 0
        const worker = async (): Promise<void> => {
          while (nextIndex < targets.length && !controller.signal.aborted) {
            await refreshTarget(targets[nextIndex++])
          }
        }
        await Promise.all(
          Array.from({ length: Math.min(MAX_CONCURRENT_SWEEP_REQUESTS, targets.length) }, worker)
        )
      } catch {
        // Why swallowed rather than propagated: every caller fires this as
        // `void sweep()` from a timer, a filesystem event or an agent
        // transition, so a throw here becomes an unhandled rejection instead of
        // reaching anyone. A glanceable count is not worth that -- rows keep
        // their previous numbers and the next sweep tries again.
      } finally {
        sweepInFlight = false
        // Why recorded here: the backoff below measures idle time from when work
        // ended and scales it by what the work cost.
        lastSweepEndedAt = Date.now()
        lastSweepDurationMs = lastSweepEndedAt - startedAt
      }
      if (sweepRequestedWhileRunning) {
        sweepRequestedWhileRunning = false
        // Why: go through the request path so the deferred run still respects the
        // spacing floor instead of chaining straight into another sweep.
        requestEventSweep()
      }
    }

    // Why: refresh every workspace rather than guessing which one an event
    // belongs to. An agent is not confined to its own worktree -- it can write
    // anywhere by absolute path -- so scoping by path would be unsound, not just
    // more code. sweep()'s in-flight guard already collapses concurrent requests.
    let quietPeriodTimer: ReturnType<typeof setTimeout> | null = null
    const requestEventSweep = (): void => {
      if (controller.signal.aborted || quietPeriodTimer) {
        return
      }
      const idleTargetMs = lastSweepDurationMs * EVENT_SWEEP_IDLE_MULTIPLIER
      const idleSoFarMs = Date.now() - lastSweepEndedAt
      const delay = Math.max(EVENT_QUIET_PERIOD_MS, idleTargetMs - idleSoFarMs)
      quietPeriodTimer = setTimeout(() => {
        quietPeriodTimer = null
        if (controller.signal.aborted) {
          return
        }
        void sweep()
      }, delay)
    }
    requestEventSweepRef.current = requestEventSweep

    // Sweeps immediately, pauses while the window is hidden, and catches up as
    // soon as it is visible again -- a hidden window drops signals, so the
    // becoming-visible run is evidence-bearing rather than a bare tick.
    const uninstallInterval = installWindowVisibilityInterval({
      run: () => void sweep(),
      intervalMs: SIDEBAR_CHANGE_COUNT_POLL_INTERVAL_MS
    })

    // Why: the app already watches the working tree of whatever the user has
    // open, and nothing consumed those events for Git status. Reusing them makes
    // an edit show up at once instead of on the next tick, at no watcher cost.
    // The watcher ignores .git, so commits made outside Orca still wait for the
    // interval -- that is what keeps the interval worth having.
    const unsubscribeFsChanged = window.api?.fs?.onFsChanged?.(() => requestEventSweep()) ?? null

    return () => {
      controller.abort()
      uninstallInterval()
      unsubscribeFsChanged?.()
      if (quietPeriodTimer) {
        clearTimeout(quietPeriodTimer)
      }
      requestEventSweepRef.current = () => {}
    }
  }, [enabled])

  useEffect(() => {
    if (!enabled) {
      // Why reset rather than leave it: a stale marker makes the next enable look
      // like an agent transition, so reopening the sidebar swept twice -- the
      // mount sweep already covers whatever changed while it was closed.
      lastSeenAgentEpochRef.current = null
      return
    }
    // Why: the mount sweep already covered the epoch we start on; only a change
    // after that means an agent moved.
    if (lastSeenAgentEpochRef.current === null) {
      lastSeenAgentEpochRef.current = agentStatusEpoch
      return
    }
    if (lastSeenAgentEpochRef.current === agentStatusEpoch) {
      return
    }
    lastSeenAgentEpochRef.current = agentStatusEpoch
    requestEventSweepRef.current()
  }, [agentStatusEpoch, enabled])
}
