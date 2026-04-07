import { useCallback, useMemo, useState } from 'react'
import { GitBranchPlus, Settings, SkipForward, ChevronDown } from 'lucide-react'
import { useAppStore } from '../../store'
import { ensureWorktreeHasInitialTerminal } from '../../lib/worktree-activation'
import type { Repo, Worktree } from '../../../../shared/types'
import PreflightBanner, { usePreflightIssues } from './PreflightBanner'
import KeyboardShortcuts from './KeyboardShortcuts'

// Why: session-scoped (not persisted to disk) so users see onboarding again after
// restarting the app. Avoids nagging on every repo switch while still surfacing
// guidance when the app freshly launches with no worktrees.
const dismissedRepoIds = new Set<string>()

const MAX_VISIBLE_WORKTREES = 5

type RepoOnboardingProps = {
  repo: Repo
  linkedWorktrees: Worktree[]
  onDismiss: () => void
}

function LinkedWorktreeItem({ worktree }: { worktree: Worktree }): React.JSX.Element {
  const setActiveWorktree = useAppStore((s) => s.setActiveWorktree)
  const revealWorktreeInSidebar = useAppStore((s) => s.revealWorktreeInSidebar)

  const handleOpen = useCallback(() => {
    setActiveWorktree(worktree.id)
    // Why: opening an existing linked worktree from onboarding should create an
    // initial terminal tab using the same activation path as post-create. This is
    // a visibility/activation improvement, not a filesystem mutation — no git
    // worktree add, no disk changes, no setup runner.
    ensureWorktreeHasInitialTerminal(useAppStore.getState(), worktree.id)
    revealWorktreeInSidebar(worktree.id)
  }, [worktree.id, setActiveWorktree, revealWorktreeInSidebar])

  // Show branch name without refs/heads/ prefix for readability
  const branchLabel = worktree.branch.replace(/^refs\/heads\//, '')

  return (
    <button
      className="group flex items-center justify-between gap-3 w-full rounded-md border border-border/60 bg-secondary/30 px-3 py-2 text-left transition-colors hover:bg-accent cursor-pointer"
      onClick={handleOpen}
    >
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground truncate">{worktree.displayName}</p>
        {branchLabel !== worktree.displayName && (
          <p className="text-xs text-muted-foreground truncate mt-0.5">{branchLabel}</p>
        )}
      </div>
      <span className="shrink-0 text-xs font-medium text-muted-foreground group-hover:text-foreground transition-colors">
        Open
      </span>
    </button>
  )
}

export default function RepoOnboarding({
  repo,
  linkedWorktrees,
  onDismiss
}: RepoOnboardingProps): React.JSX.Element {
  const openModal = useAppStore((s) => s.openModal)
  const setActiveView = useAppStore((s) => s.setActiveView)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)

  const preflightIssues = usePreflightIssues()
  const [showAll, setShowAll] = useState(false)

  const hasLinkedWorktrees = linkedWorktrees.length > 0
  const hasOverflow = linkedWorktrees.length > MAX_VISIBLE_WORKTREES

  // Why: sort by recent activity (lastActivityAt) with alphabetical fallback for
  // worktrees not yet opened in Orca. This matches the existing buildWorktreeComparator
  // behavior and avoids promising a sort criterion (like "last checked out") that has
  // no data source in git worktree list.
  const sortedWorktrees = useMemo(() => {
    return [...linkedWorktrees].sort((a, b) => {
      if (a.lastActivityAt !== b.lastActivityAt) {
        return b.lastActivityAt - a.lastActivityAt
      }
      return a.displayName.localeCompare(b.displayName)
    })
  }, [linkedWorktrees])

  const visibleWorktrees = showAll
    ? sortedWorktrees
    : sortedWorktrees.slice(0, MAX_VISIBLE_WORKTREES)

  const handleCreateWorktree = useCallback(() => {
    openModal('create-worktree', { preselectedRepoId: repo.id })
  }, [openModal, repo.id])

  const handleConfigureRepo = useCallback(() => {
    openSettingsTarget({ pane: 'repo', repoId: repo.id })
    setActiveView('settings')
  }, [openSettingsTarget, setActiveView, repo.id])

  const handleDismiss = useCallback(() => {
    dismissedRepoIds.add(repo.id)
    onDismiss()
  }, [repo.id, onDismiss])

  return (
    <div className="absolute inset-0 overflow-y-auto bg-background">
      <div className="flex min-h-full items-center justify-center">
        <div className="w-full max-w-lg px-6">
          <div className="flex flex-col items-center gap-5 py-8">
            <PreflightBanner issues={preflightIssues} />

            {/* Headline */}
            <div className="text-center space-y-2">
              <h1 className="text-2xl font-bold text-foreground tracking-tight">
                {hasLinkedWorktrees ? 'Open or create a worktree' : 'Set up your first worktree'}
              </h1>
              <p className="text-sm text-muted-foreground">
                {hasLinkedWorktrees ? (
                  <>
                    <span className="font-medium text-foreground">{repo.displayName}</span> has{' '}
                    {linkedWorktrees.length} worktree{linkedWorktrees.length !== 1 && 's'}. Open one
                    to pick up where you left off, or create a new one.
                  </>
                ) : (
                  <>
                    Orca uses git worktrees as isolated task environments.
                    <br />
                    Create one for{' '}
                    <span className="font-medium text-foreground">{repo.displayName}</span> to get
                    started.
                  </>
                )}
              </p>
            </div>

            {/* Existing linked worktrees */}
            {hasLinkedWorktrees && (
              <div className="w-full space-y-2">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Existing worktrees
                </p>
                <div className="space-y-1.5">
                  {visibleWorktrees.map((wt) => (
                    <LinkedWorktreeItem key={wt.id} worktree={wt} />
                  ))}
                </div>
                {hasOverflow && (
                  <button
                    className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors cursor-pointer mx-auto"
                    onClick={() => setShowAll((v) => !v)}
                  >
                    <ChevronDown
                      className={`size-3 transition-transform ${showAll ? 'rotate-180' : ''}`}
                    />
                    {showAll ? 'Show less' : `View all ${linkedWorktrees.length} worktrees`}
                  </button>
                )}
              </div>
            )}

            {/* Primary CTA */}
            <div className="flex items-center justify-center gap-2.5 flex-wrap w-full">
              <button
                className="inline-flex items-center gap-1.5 bg-primary text-primary-foreground font-medium text-sm px-4 py-2 rounded-md cursor-pointer hover:bg-primary/90 transition-colors"
                onClick={handleCreateWorktree}
              >
                <GitBranchPlus className="size-3.5" />
                {hasLinkedWorktrees ? 'Create new worktree' : 'Create first worktree'}
              </button>
            </div>

            {/* Secondary CTAs */}
            <div className="flex items-center justify-center gap-3 flex-wrap">
              <button
                className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                onClick={handleConfigureRepo}
              >
                <Settings className="size-3.5" />
                Configure repo
              </button>

              <span className="text-border">|</span>

              <button
                className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                onClick={handleDismiss}
              >
                <SkipForward className="size-3.5" />
                Skip for now
              </button>
            </div>

            <KeyboardShortcuts />
          </div>
        </div>
      </div>
    </div>
  )
}

/** Check whether onboarding has been dismissed for the given repo this session. */
export function isOnboardingDismissed(repoId: string): boolean {
  return dismissedRepoIds.has(repoId)
}

/** Clear dismissal for a repo (e.g., if all its worktrees are removed). */
export function clearOnboardingDismissal(repoId: string): void {
  dismissedRepoIds.delete(repoId)
}
