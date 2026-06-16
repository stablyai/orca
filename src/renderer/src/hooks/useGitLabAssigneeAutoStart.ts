import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { launchWorkItemDirect } from '@/lib/launch-work-item-direct'
import { isGitRepoKind } from '../../../shared/repo-kind'
import type { GitLabWorkItem } from '../../../shared/gitlab-types'

// Why: this watcher does nothing more than the normal "select an issue and
// start its processing in Orca" click — it just fires it automatically when a
// configured GitLab user is the assignee. It reuses the exact existing calls
// (`window.api.gl.listIssues` for the sync, `launchWorkItemDirect` for the
// click) so there is no separate headless execution path.

const MIN_INTERVAL_SECONDS = 20
// Why: cap launches per tick so a first run with many already-assigned issues
// (or a freshly-assigned batch) doesn't spawn a thundering herd of workspaces
// in one pass. Remaining matches are picked up on subsequent ticks.
const MAX_LAUNCHES_PER_TICK = 5

function autoStartKey(repoId: string, issueNumber: number): string {
  return `${repoId}:${issueNumber}`
}

/**
 * Pure dedup predicate: has this GitLab issue already been auto-started?
 * True when a launch is in flight this session, or a workspace is already
 * linked to the issue (durable, survives restarts). Exported for testing.
 */
export function isGitLabIssueAlreadyStarted(args: {
  worktrees: readonly { repoId: string; linkedGitLabIssue?: number | null }[]
  inFlight: ReadonlySet<string>
  repoId: string
  issueNumber: number
}): boolean {
  if (args.inFlight.has(autoStartKey(args.repoId, args.issueNumber))) {
    return true
  }
  return args.worktrees.some(
    (worktree) => worktree.repoId === args.repoId && worktree.linkedGitLabIssue === args.issueNumber
  )
}

/**
 * Background watcher that auto-starts GitLab issues assigned to a configured
 * user. Inert unless `gitlabAutoStartEnabled` is true and a non-empty
 * `gitlabAutoStartAssignee` handle is set. Mount once at the app root.
 */
export function useGitLabAssigneeAutoStart(): void {
  const enabled = useAppStore((s) => s.settings?.gitlabAutoStartEnabled ?? false)
  const assigneeSetting = useAppStore((s) => s.settings?.gitlabAutoStartAssignee ?? '')
  const intervalSeconds = useAppStore((s) => s.settings?.gitlabAutoStartIntervalSeconds ?? 60)

  // Why: createWorktree is async, so a launched issue's worktree (our durable
  // dedup signal) may not exist yet on the next tick. Track in-flight launches
  // in memory so the same issue is never started twice within a session.
  const inFlightRef = useRef<Set<string>>(new Set())
  const runningRef = useRef(false)
  // Why: a real glab failure (auth/network/rate-limit) for one repo must be
  // visible (fail-loud), but a persistent failure shouldn't toast every tick.
  // Track which repos have an outstanding reported error; cleared on recovery.
  const reportedRepoErrorsRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    const handle = assigneeSetting.trim().replace(/^@/, '')
    if (!enabled || !handle) {
      return
    }
    const intervalMs = Math.max(MIN_INTERVAL_SECONDS, intervalSeconds) * 1000
    let cancelled = false

    const isAlreadyStarted = (repoId: string, issueNumber: number): boolean =>
      isGitLabIssueAlreadyStarted({
        worktrees: useAppStore.getState().allWorktrees(),
        inFlight: inFlightRef.current,
        repoId,
        issueNumber
      })

    // Fail-loud: surface a real per-repo fetch failure in-band (toast) once, so
    // auto-start silently dying for a repo is visible. Other repos still run.
    const reportRepoFetchError = (
      repo: { id: string; path: string; displayName?: string },
      detail: unknown
    ): void => {
      console.error(`[gitlab-autostart] listIssues failed for ${repo.path}:`, detail)
      if (reportedRepoErrorsRef.current.has(repo.id)) {
        return
      }
      reportedRepoErrorsRef.current.add(repo.id)
      const name = repo.displayName ?? repo.path
      const reason = detail instanceof Error ? detail.message : String(detail)
      toast.error(`Auto-start: could not load GitLab issues for "${name}" — ${reason}`)
    }

    const tick = async (): Promise<void> => {
      if (runningRef.current || cancelled) {
        return
      }
      runningRef.current = true
      try {
        const store = useAppStore.getState()
        const repos = store.repos.filter((repo) => isGitRepoKind(repo))
        let launched = 0
        for (const repo of repos) {
          if (cancelled || launched >= MAX_LAUNCHES_PER_TICK) {
            break
          }
          type ListIssuesResponse = {
            items?: GitLabWorkItem[]
            error?: { type?: string; message?: string }
          }
          let response: ListIssuesResponse | null = null
          try {
            response = (await window.api.gl.listIssues({
              repoPath: repo.path,
              repoId: repo.id,
              state: 'opened',
              assignee: handle,
              limit: 50
            })) as ListIssuesResponse
          } catch (err) {
            // Fail-loud: a real glab failure (auth/network/rate-limit) is surfaced
            // in-band, not silently swallowed. Other repos still run; this repo
            // retries next tick.
            reportRepoFetchError(repo, err)
            continue
          }
          if (response?.error) {
            // not_found just means "this repo isn't a GitLab project" — skip quietly.
            if (response.error.type !== 'not_found') {
              reportRepoFetchError(
                repo,
                response.error.message ?? response.error.type ?? 'unknown error'
              )
            }
            continue
          }
          // Recovered: a prior error for this repo no longer applies.
          reportedRepoErrorsRef.current.delete(repo.id)
          for (const item of response?.items ?? []) {
            // Re-check `cancelled` each iteration: launches are awaited, so a
            // cleanup (feature disabled / unmount) mid-tick must stop further
            // launches rather than keep spawning workspaces after teardown.
            if (cancelled || launched >= MAX_LAUNCHES_PER_TICK) {
              break
            }
            if (item.type !== 'issue' || isAlreadyStarted(repo.id, item.number)) {
              continue
            }
            const key = autoStartKey(repo.id, item.number)
            // Optimistic dedup: mark before launching so a transient launch
            // failure never double-creates a workspace for the same issue.
            inFlightRef.current.add(key)
            launched += 1
            // Why: await each launch so one issue's worktree creation finishes
            // before the next starts. Concurrent `git worktree add` on the same
            // repo would race on .git/index.lock; the runningRef guard already
            // prevents overlapping ticks, so serial launches here are safe.
            try {
              const ok = await launchWorkItemDirect({
                item: {
                  title: item.title,
                  url: item.url,
                  type: 'issue',
                  number: item.number,
                  repoId: repo.id
                },
                repoId: repo.id,
                launchSource: 'task_page',
                telemetrySource: 'sidebar',
                // Why: an unattended pickup must actually run — always submit the
                // prompt rather than leaving it as a draft for a human to send.
                promptDelivery: 'submit-after-ready',
                // No interactive fallback: if Orca needs user input (e.g. a
                // setup-policy prompt), skip this issue; it retries next tick.
                openModalFallback: () => {
                  inFlightRef.current.delete(key)
                }
              })
              if (!ok) {
                inFlightRef.current.delete(key)
              }
            } catch {
              inFlightRef.current.delete(key)
            }
          }
        }
      } finally {
        runningRef.current = false
      }
    }

    void tick()
    const timer = setInterval(() => void tick(), intervalMs)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [enabled, assigneeSetting, intervalSeconds])
}
