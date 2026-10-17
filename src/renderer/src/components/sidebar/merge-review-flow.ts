import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { getConnectionId } from '@/lib/connection-context'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { requestWorktreeMergeReviewRefresh } from './use-worktree-merge-review-state'

export type WorktreeMergeReviewActionArgs = {
  /** Any worktree of the repository; the host resolves the main checkout itself. */
  worktreePath: string
  worktreeId: string
  repoId: string
  /** Main checkout row, so a conflicted merge can be revealed in its Source Control panel. */
  mainWorktreeId: string | null
}

/** Paths shown inline before the toast would outgrow itself. */
const MAX_LISTED_PATHS = 5

function listPaths(paths: readonly string[]): string {
  const listed = paths.slice(0, MAX_LISTED_PATHS).join('\n')
  return paths.length > MAX_LISTED_PATHS
    ? `${listed}\n${translate('components.sidebar.mergeReview.andMorePaths', 'and {{count}} more', { count: paths.length - MAX_LISTED_PATHS })}`
    : listed
}

/**
 * Why keyed by repository: two cards of the same repo can each start an
 * operation, and a second merge would race the first on the same index.
 */
const inFlightRepos = new Set<string>()

async function runGuarded(repoId: string, run: () => Promise<void>): Promise<void> {
  if (inFlightRepos.has(repoId)) {
    return
  }
  inFlightRepos.add(repoId)
  try {
    await run()
  } finally {
    inFlightRepos.delete(repoId)
  }
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Brings the main checkout's Source Control panel forward so conflicts are actionable. */
function revealMainWorktreeSourceControl(mainWorktreeId: string): void {
  const store = useAppStore.getState()
  activateAndRevealWorktree(mainWorktreeId, { providesInitialSurface: true })
  store.setRightSidebarTab('source-control')
  store.setRightSidebarOpen(true)
}

export function runWorktreeMergeReviewSync(args: WorktreeMergeReviewActionArgs): void {
  const connectionId = getConnectionId(args.worktreeId) ?? undefined
  void runGuarded(args.repoId, async () => {
    try {
      const outcome = await window.api.git.worktreeMergeReviewSync({
        worktreePath: args.worktreePath,
        ...(connectionId ? { connectionId } : {})
      })
      if (outcome.kind === 'nothing-to-merge') {
        toast.info(
          translate(
            'components.sidebar.mergeReview.nothingToMerge',
            'Nothing to merge — the main worktree already has these changes'
          )
        )
        return
      }
      if (outcome.conflicts.length > 0) {
        toast.warning(
          translate('components.sidebar.mergeReview.syncConflicts', 'Merged with conflicts'),
          { description: listPaths(outcome.conflicts) }
        )
        if (args.mainWorktreeId) {
          revealMainWorktreeSourceControl(args.mainWorktreeId)
        }
        return
      }
      toast.success(
        translate(
          'components.sidebar.mergeReview.syncSuccess',
          'Merged into the main worktree — awaiting review'
        ),
        { description: outcome.stat }
      )
    } catch (error) {
      toast.error(failureMessage(error))
    } finally {
      requestWorktreeMergeReviewRefresh()
    }
  })
}

export function runWorktreeMergeReviewAccept(args: WorktreeMergeReviewActionArgs): void {
  const connectionId = getConnectionId(args.worktreeId) ?? undefined
  void runGuarded(args.repoId, async () => {
    try {
      const outcome = await window.api.git.worktreeMergeReviewAccept({
        worktreePath: args.worktreePath,
        ...(connectionId ? { connectionId } : {})
      })
      if (outcome.kind === 'committed') {
        toast.success(
          translate('components.sidebar.mergeReview.acceptSuccess', 'Merge committed'),
          { description: outcome.summary }
        )
        return
      }
      toast.success(
        translate(
          'components.sidebar.mergeReview.stashRestored',
          "Restored the main worktree's changes"
        )
      )
    } catch (error) {
      toast.error(failureMessage(error))
    } finally {
      requestWorktreeMergeReviewRefresh()
    }
  })
}

/**
 * `assumeYes` is the second half of the confirmation protocol: the first call
 * returns the paths a reject would discard instead of acting, and only the
 * dialog's confirm re-enters with it set.
 */
export function runWorktreeMergeReviewReject(
  args: WorktreeMergeReviewActionArgs,
  assumeYes = false
): void {
  const connectionId = getConnectionId(args.worktreeId) ?? undefined
  void runGuarded(args.repoId, async () => {
    try {
      const outcome = await window.api.git.worktreeMergeReviewReject({
        worktreePath: args.worktreePath,
        ...(connectionId ? { connectionId } : {}),
        ...(assumeYes ? { assumeYes: true } : {})
      })
      if (outcome.kind === 'needs-confirmation') {
        useAppStore.getState().openModal('merge-review-reject', {
          worktreePath: args.worktreePath,
          worktreeId: args.worktreeId,
          repoId: args.repoId,
          mainWorktreeId: args.mainWorktreeId,
          paths: outcome.paths
        })
        return
      }
      toast.success(
        outcome.kind === 'stash-restored'
          ? translate(
              'components.sidebar.mergeReview.stashRestored',
              "Restored the main worktree's changes"
            )
          : translate('components.sidebar.mergeReview.rejectSuccess', 'Merge undone')
      )
    } catch (error) {
      toast.error(failureMessage(error))
    } finally {
      requestWorktreeMergeReviewRefresh()
    }
  })
}
