import { ArrowDown, ArrowUp, ArrowUpRight, ChevronRight, FolderGit2, GitBranch } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

// Each attached worktree is an embedded card so its groups and COMMITS dock never read as another repo's.
export const FOLDER_WORKTREE_CARD_CLASS =
  'overflow-clip rounded-xl border border-input bg-card shadow-xs'

type FolderWorktreeSectionHeaderProps = {
  repoName: string
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
  branch,
  ahead,
  behind,
  changeCount,
  expanded,
  onToggle,
  onOpen
}: FolderWorktreeSectionHeaderProps): React.JSX.Element {
  const openLabel = translate(
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
        className="flex min-w-0 flex-1 items-center gap-1.5 py-2 pl-2 text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <ChevronRight
          className={`size-3 shrink-0 text-muted-foreground ${expanded ? 'rotate-90' : ''}`}
        />
        <FolderGit2 className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="max-w-[50%] shrink-0 truncate text-[13px] font-semibold">{repoName}</span>
        <span className="flex min-w-0 items-center gap-1 rounded-full border border-input px-1.5 text-muted-foreground">
          <GitBranch className="size-3 shrink-0" />
          <span className="truncate">{branch}</span>
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1 text-muted-foreground">
          {!!ahead && (
            <span className="flex items-center">
              <ArrowUp className="size-3" />
              {ahead}
            </span>
          )}
          {!!behind && (
            <span className="flex items-center">
              <ArrowDown className="size-3" />
              {behind}
            </span>
          )}
          {changeCount > 0 && (
            <span className="rounded-full bg-muted px-1.5 text-2xs text-foreground">
              {changeCount}
            </span>
          )}
        </span>
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
