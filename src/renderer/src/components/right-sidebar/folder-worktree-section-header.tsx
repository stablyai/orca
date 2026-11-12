import { ArrowDown, ArrowUp, ArrowUpRight, ChevronRight, FolderGit2, GitBranch } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

// Each attached worktree is an embedded card so its groups and COMMITS dock never read as another repo's.
export const FOLDER_WORKTREE_CARD_CLASS =
  'overflow-clip rounded-xl border border-input bg-card shadow-xs'

type FolderWorktreeSectionHeaderProps = {
  repoName: string
  worktreeName?: string
  branch: string
  ahead?: number
  behind?: number
  changeCount: number
  expanded: boolean
  showBranchInHeader?: boolean
  actions?: React.ReactNode
  onToggle: () => void
  onOpen: () => void
  /** Receives the embedded panel's filter and overflow buttons while expanded. */
  actionsSlotRef: (element: HTMLDivElement | null) => void
}

function AheadBehind({ ahead, behind }: { ahead?: number; behind?: number }): React.JSX.Element {
  return (
    <>
      {!!ahead && (
        <span className="flex shrink-0 items-center tabular-nums">
          <ArrowUp className="size-3" />
          {ahead}
        </span>
      )}
      {!!behind && (
        <span className="flex shrink-0 items-center tabular-nums">
          <ArrowDown className="size-3" />
          {behind}
        </span>
      )}
    </>
  )
}

export function FolderWorktreeSectionHeader({
  repoName,
  worktreeName,
  branch,
  ahead,
  behind,
  changeCount,
  expanded,
  showBranchInHeader = !expanded,
  actions,
  onToggle,
  onOpen,
  actionsSlotRef
}: FolderWorktreeSectionHeaderProps): React.JSX.Element {
  const t = useTranslate()
  const openLabel = t(
    'auto.components.rightSidebar.FolderWorkspaceSourceControl.openWorktree',
    'Open this worktree'
  )
  const showWorktreeName = !!worktreeName && worktreeName !== branch
  // Expanded cards show the branch once, in the body's picker; collapsed cards have no body.
  const showSummaryRow = showBranchInHeader && (!!branch || !!ahead || !!behind || changeCount > 0)
  return (
    // Pinned within its own card, above the panel's sticky COMMITS dock.
    <div
      className={`group/card-header sticky top-0 z-20 flex flex-col gap-0.5 bg-card py-1.5 pl-2 pr-1 text-xs hover:bg-accent ${expanded ? 'border-b border-input' : ''}`}
    >
      <span className="flex min-h-5 w-full min-w-0 items-center gap-1.5">
        {/* Its ::after covers the header so any empty space toggles; the other controls sit above it. */}
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={[repoName, showWorktreeName ? worktreeName : null, branch]
            .filter(Boolean)
            .join(', ')}
          onClick={onToggle}
          className="flex min-w-0 items-center gap-1.5 text-left after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:ring-1 focus-visible:after:ring-inset focus-visible:after:ring-ring"
        >
          <ChevronRight
            className={`size-3 shrink-0 text-muted-foreground ${expanded ? 'rotate-90' : ''}`}
          />
          <FolderGit2 className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate text-[13px] font-semibold" title={repoName}>
            {repoName}
          </span>
          {/* Same-repo worktrees are told apart by name, as main did. */}
          {showWorktreeName && (
            <span className="min-w-0 truncate text-muted-foreground" title={worktreeName}>
              {worktreeName}
            </span>
          )}
        </button>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="relative z-10 -my-0.5 size-5 shrink-0"
              onClick={onOpen}
              aria-label={openLabel}
            >
              <ArrowUpRight className="size-3.5 text-muted-foreground group-hover/card-header:text-foreground" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{openLabel}</TooltipContent>
        </Tooltip>
        <span className="min-w-0 flex-1" />
        {expanded && (
          <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
            <AheadBehind ahead={ahead} behind={behind} />
          </span>
        )}
        <div
          ref={actionsSlotRef}
          className="relative z-10 -my-1 flex shrink-0 items-center empty:hidden"
        >
          {actions}
        </div>
      </span>
      {showSummaryRow && (
        <span className="flex w-full min-w-0 items-center gap-1 pl-[2.375rem] pr-1 text-muted-foreground">
          {branch && (
            <span className="flex min-w-0 items-center gap-1 rounded-full border border-input px-1.5">
              <GitBranch className="size-3 shrink-0" />
              <span className="truncate" title={branch}>
                {branch}
              </span>
            </span>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-1">
            {!expanded && <AheadBehind ahead={ahead} behind={behind} />}
            {!expanded && changeCount > 0 && (
              <span className="text-2xs tabular-nums">
                {t(
                  'auto.components.rightSidebar.FolderWorkspaceSourceControl.changeCount',
                  '{{count}} changes',
                  { count: changeCount, defaultValue_one: '{{count}} change' }
                )}
              </span>
            )}
          </span>
        </span>
      )}
    </div>
  )
}
