import type { TaskProvider } from '../../../shared/task-providers'

export type TaskSourceSelectionStash = Partial<Record<TaskProvider, ReadonlySet<string>>>

/**
 * Resolve a task-source switch's selection swap (#15784).
 *
 * The Tasks page keeps one project selection, but the tools it drives are
 * provider-specific: a repo selected for GitLab has no GitHub source and a
 * GitHub repo has no GitLab remote, so sharing one selection across tools made
 * every switch run fetches against the wrong provider. The swap stashes the
 * outgoing source's selection and restores the incoming source's own stash —
 * or the page's initial selection the first time that source is visited.
 */
export function resolveTaskSourceSelectionSwap(args: {
  previousSource: TaskProvider
  nextSource: TaskProvider
  currentSelection: ReadonlySet<string>
  stash: TaskSourceSelectionStash
  fallbackSelection: ReadonlySet<string>
}): { stash: TaskSourceSelectionStash; nextSelection: ReadonlySet<string> } {
  const nextStash: TaskSourceSelectionStash = {
    ...args.stash,
    [args.previousSource]: args.currentSelection
  }
  const stashed = nextStash[args.nextSource]
  return {
    stash: nextStash,
    nextSelection: stashed ?? args.fallbackSelection
  }
}
