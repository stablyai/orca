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
  onToggle: () => void
  onOpen: () => void
}

export function FolderWorktreeSectionHeader({
  repoName,
  worktreeName,
  branch,
  ahead,
  behind,
  changeCount,
  expanded,
  onToggle,
  onOpen
}: FolderWorktreeSectionHeaderProps): React.JSX.Element {
  const t = useTranslate()
  const openLabel = t(
    'auto.components.rightSidebar.FolderWorkspaceSourceControl.openWorktree',
    'Open this worktree'
  )
  return (
    // Pinned within its own card, above the panel's sticky COMMITS dock.
    <div
      className={`sticky top-0 z-20 flex items-center gap-1 bg-card pr-1 ${expanded ? 'border-b border-input' : ''}`}
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="flex min-w-0 flex-1 flex-col gap-0.5 py-1.5 pl-2 text-left text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span className="flex w-full min-w-0 items-center gap-1.5">
          <ChevronRight
            className={`size-3 shrink-0 text-muted-foreground ${expanded ? 'rotate-90' : ''}`}
          />
          <FolderGit2 className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate text-[13px] font-semibold">{repoName}</span>
          {/* Same-repo worktrees are told apart by name, as main did. */}
          {worktreeName && worktreeName !== branch && (
            <span
              title={worktreeName}
              className="min-w-0 flex-1 basis-0 truncate text-muted-foreground"
            >
              {worktreeName}
            </span>
          )}
          {changeCount > 0 && (
            <span className="ml-auto shrink-0 rounded-full bg-muted px-1.5 text-2xs text-foreground">
              {changeCount}
            </span>
          )}
        </span>
        {(branch || !!ahead || !!behind) && (
          <span className="flex w-full min-w-0 items-center gap-1 pl-[1.625rem] text-muted-foreground">
            {branch && (
              <span
                title={branch}
                className="flex min-w-0 items-center gap-1 rounded-full border border-input px-1.5"
              >
                <GitBranch className="size-3 shrink-0" />
                <span className="truncate">{branch}</span>
              </span>
            )}
            {!!ahead && (
              <span className="ml-auto flex shrink-0 items-center">
                <ArrowUp className="size-3" />
                {ahead}
              </span>
            )}
            {!!behind && (
              <span className={`flex shrink-0 items-center ${ahead ? '' : 'ml-auto'}`}>
                <ArrowDown className="size-3" />
                {behind}
              </span>
            )}
          </span>
        )}
      </button>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-6 shrink-0"
            onClick={onOpen}
            aria-label={openLabel}
          >
            <ArrowUpRight className="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{openLabel}</TooltipContent>
      </Tooltip>
    </div>
  )
}
