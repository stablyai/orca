import { useEffect } from 'react'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { getAllWorktreesFromState, getRepoMapFromState } from '@/store/selectors'
import { getTabIdToWorktreeId } from '@/components/sidebar/worktree-agent-row-selectors'
import { getRuntimeGitStatus } from '@/runtime/runtime-git-status-client'
import { parsePaneKey } from '../../../../../../shared/stable-pane-id'
import { getRepoExecutionHostId } from '../../../../../../shared/execution-host'
import { isFolderRepo } from '../../../../../../shared/repo-kind'
import type { AgentStatusEntry } from '../../../../../../shared/agent-status-types'
import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { classifyAgentWritePath } from './linked-repo-path-match'
import { extractToolPathUses } from './linked-repo-tool-paths'
import { isWorktreeLinked, linkWorktree } from './linked-worktree-store'
import { linkedWorktreeGitContext } from './use-linked-worktree-status'

// Hooks report a tool as it starts, so re-check while a shell command finishes writing.
const SHELL_VERIFY_DELAYS_MS = [1_500, 6_000, 20_000]

function entryWorktreeId(
  state: AppState,
  paneKey: string,
  entry: AgentStatusEntry
): string | undefined {
  const tabId = entry.tabId ?? parsePaneKey(paneKey)?.tabId
  return (
    (tabId ? getTabIdToWorktreeId(state.tabsByWorktree).get(tabId) : undefined) ?? entry.worktreeId
  )
}

type Candidate = { worktree: Worktree; repo: Repo; id: string; path: string }

/** The source worktree plus Git worktrees on its host; other hosts cannot share paths. */
function sourceContext(
  state: AppState,
  sourceWorktreeId: string
): { source: Worktree; candidates: Candidate[] } | null {
  const repos = getRepoMapFromState(state)
  const worktrees = getAllWorktreesFromState(state)
  const source = worktrees.find((worktree) => worktree.id === sourceWorktreeId)
  const sourceRepo = source ? repos.get(source.repoId) : undefined
  if (!source || !sourceRepo) {
    return null
  }
  const hostId = getRepoExecutionHostId(sourceRepo)
  const candidates = worktrees.flatMap((worktree) => {
    const repo = repos.get(worktree.repoId)
    return repo &&
      !isFolderRepo(repo) &&
      !worktree.isArchived &&
      getRepoExecutionHostId(repo) === hostId
      ? [{ worktree, repo, id: worktree.id, path: worktree.path }]
      : []
  })
  return { source, candidates }
}

/** Link only once Git shows changes, so read-only commands in another project never link it. */
function createShellVerifier(): {
  verify: (sourceWorktreeId: string, candidate: Candidate) => void
  dispose: () => void
} {
  const pending = new Map<string, number[]>()
  const verify = (sourceWorktreeId: string, candidate: Candidate): void => {
    const key = `${sourceWorktreeId}\0${candidate.id}`
    const context = linkedWorktreeGitContext(candidate.worktree, candidate.repo)
    if (!context || pending.has(key) || isWorktreeLinked(sourceWorktreeId, candidate.id)) {
      return
    }
    const timers: number[] = []
    const settle = (): void => {
      timers.forEach((timer) => window.clearTimeout(timer))
      pending.delete(key)
    }
    SHELL_VERIFY_DELAYS_MS.forEach((delay, index) => {
      timers.push(
        window.setTimeout(async () => {
          try {
            const status = await getRuntimeGitStatus(context, {
              admissionTier: 'background',
              includeLineStats: false
            })
            if (status.entries.length > 0) {
              linkWorktree(sourceWorktreeId, candidate.id)
              settle()
              return
            }
          } catch {
            // An unreachable host just leaves the project unlinked.
          }
          if (index === SHELL_VERIFY_DELAYS_MS.length - 1) {
            settle()
          }
        }, delay)
      )
    })
    pending.set(key, timers)
  }
  const dispose = (): void => {
    for (const timers of pending.values()) {
      timers.forEach((timer) => window.clearTimeout(timer))
    }
    pending.clear()
  }
  return { verify, dispose }
}

/** Link another added project to a workspace once one of its agents changes files there. */
export function useLinkedWorktreeDetection(): void {
  useEffect(() => {
    const verifier = createShellVerifier()
    const seenToolByPaneKey = new Map<string, string>()
    const scan = (state: AppState): void => {
      for (const [paneKey, entry] of Object.entries(state.agentStatusByPaneKey)) {
        const uses = extractToolPathUses(entry.toolName, entry.toolInput)
        if (uses.length === 0) {
          continue
        }
        const toolKey = `${entry.toolName}\0${entry.toolInput}`
        if (seenToolByPaneKey.get(paneKey) === toolKey) {
          continue
        }
        seenToolByPaneKey.set(paneKey, toolKey)
        const sourceWorktreeId = entryWorktreeId(state, paneKey, entry)
        const context = sourceWorktreeId ? sourceContext(state, sourceWorktreeId) : null
        if (!sourceWorktreeId || !context) {
          continue
        }
        for (const use of uses) {
          const target = classifyAgentWritePath(use.path, context.candidates, context.source)
          if (target.kind !== 'registered') {
            continue
          }
          const candidate = context.candidates.find((c) => c.id === target.worktree.id)
          if (use.certainWrite) {
            linkWorktree(sourceWorktreeId, target.worktree.id)
          } else if (candidate) {
            verifier.verify(sourceWorktreeId, candidate)
          }
        }
      }
    }
    scan(useAppStore.getState())
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (state.agentStatusByPaneKey !== previous.agentStatusByPaneKey) {
        scan(state)
      }
    })
    return () => {
      unsubscribe()
      verifier.dispose()
    }
  }, [])
}
