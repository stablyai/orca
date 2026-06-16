import { useEffect, useRef } from 'react'
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

  useEffect(() => {
    const handle = assigneeSetting.trim().replace(/^@/, '')
    if (!enabled || !handle) {
      return
    }
    const intervalMs = Math.max(MIN_INTERVAL_SECONDS, intervalSeconds) * 1000
    let cancelled = false

    const isAlreadyStarted = (repoId: string, issueNumber: number): boolean => {
      const key = autoStartKey(repoId, issueNumber)
      if (inFlightRef.current.has(key)) {
        return true
      }
      // Durable dedup: a workspace already linked to this issue means it has
      // been started (survives restarts and storage resets).
      return useAppStore
        .getState()
        .allWorktrees()
        .some(
          (worktree) => worktree.repoId === repoId && worktree.linkedGitLabIssue === issueNumber
        )
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
          let response: { items?: GitLabWorkItem[]; error?: { type?: string } } | null = null
          try {
            response = (await window.api.gl.listIssues({
              repoPath: repo.path,
              repoId: repo.id,
              state: 'opened',
              assignee: handle,
              limit: 50
            })) as { items?: GitLabWorkItem[]; error?: { type?: string } }
          } catch {
            // Why: a transient glab failure for one repo must not sink the rest.
            continue
          }
          // not_found just means "this repo isn't a GitLab project" — skip it.
          if (response?.error && response.error.type !== 'not_found') {
            continue
          }
          for (const item of response?.items ?? []) {
            if (launched >= MAX_LAUNCHES_PER_TICK) {
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
            void launchWorkItemDirect({
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
            }).then(
              (ok) => {
                if (!ok) {
                  inFlightRef.current.delete(key)
                }
              },
              () => {
                inFlightRef.current.delete(key)
              }
            )
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
