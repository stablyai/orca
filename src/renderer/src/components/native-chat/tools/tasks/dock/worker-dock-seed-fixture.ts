import type { WorkerDockRowView } from './WorkerDockRow'

// Dev-only: the invented workers the worker dock fixtures seed their chats with.
export const SOURCE = '6c3f8e4a-ad5b-4a9c-9e37-2f4d8a0b3c59'
const TITLES = [
  'Fix streaming journal amplification',
  'Fix repeated worktree catalog scans',
  'Cache the branch list per repository',
  'Drop the duplicate status poll',
  'Batch the sidebar badge writes',
  'Stream the diff instead of buffering it',
  'Reuse the parsed config between tabs',
  'Coalesce terminal resize events',
  'Skip hidden pane layout passes',
  'Index session history by worktree',
  'Defer the plugin manifest scan',
  'Trim the startup font preload',
  'Share one watcher per repository',
  'Avoid re-sorting the unchanged roster',
  'Split the dock read model',
  'Bound the activity refresh',
  'Drop the second layout read',
  'Keep the composer height stable',
  'Collapse duplicate wakes',
  'Name the answering turn'
]

export function worker(index: number, state: WorkerDockRowView['state'], remote: boolean) {
  const at = Date.now() - (index + 2) * 60_000
  const failed = state === 'failed' || state === 'unexpected'
  return {
    kind: 'worker',
    id: `dock:${index}`,
    dispatchId: `ctx_fixture_${index}`,
    source: SOURCE,
    name: `ORCA-${30 + index}`,
    title: TITLES[index % TITLES.length],
    agent: index % 2 === 0 ? 'codex' : 'claude',
    model: 'gpt-6.1-sol',
    state,
    changedAt: at,
    startedAt: at,
    reason: failed ? 'Typecheck failed: 3 errors in worker-dock-read.ts' : null,
    settlement: failed ? `settled:ctx_fixture_${index}` : null,
    resultId: failed ? `result:ctx_fixture_${index}` : null,
    stoppable: state === 'running',
    ownerActionsAvailable: !remote
  } satisfies WorkerDockRowView
}

const LONG_TITLE =
  'Fix-forward: bind the listing to the resolver so a renamed branch keeps its open pull request and review comments'

export type Seed = { ask?: boolean; variety?: boolean; long?: boolean; reorder?: boolean }
export function seed(
  count: number,
  failed: number,
  remote: boolean,
  options: Seed
): WorkerDockRowView[] {
  return Array.from({ length: count }, (_, index) => {
    // Reorder: the host lists newer queued workers first; the card puts the two older running first.
    const state =
      index < failed ? 'failed' : options.reorder && index < count - 2 ? 'coordinator' : 'running'
    const row = worker(index, state, remote)
    const title = options.long && index % 2 === 0 ? `${LONG_TITLE} (${index + 1})` : row.title
    // The newest running worker asks a question: it outranks the failures in the pill and card.
    if (options.ask && index === failed) {
      return {
        ...row,
        title,
        state: 'needs-you' as const,
        changedAt: Date.now() - 30_000,
        question: 'Approve: run the migration against the staging copy of the orders database?'
      }
    }
    if (options.variety && count >= 3 && index === count - 1) {
      return { ...row, title, state: 'idle' as const, stoppable: false }
    }
    if (options.variety && count >= 4 && index === count - 2) {
      return { ...row, title, state: 'coordinator' as const }
    }
    return { ...row, title }
  })
}
