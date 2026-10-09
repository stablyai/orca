import { FolderGit2 } from 'lucide-react'
import {
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import {
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger
} from '@/components/ui/context-menu'
import { useAppStore } from '../../store'
import { translate } from '@/i18n/i18n'
import { TAB_CONTEXT_SUBMENU_CONTENT_CLASS } from './tab-context-menu-sizing'
import { listTerminalMoveWorktreeDestinations } from './move-terminal-to-worktree-destinations'

export function useTerminalMoveDestinations(sourceWorktreeId: string) {
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const folderWorkspaces = useAppStore((s) => s.folderWorkspaces)
  return listTerminalMoveWorktreeDestinations({
    sourceWorktreeId,
    worktreesByRepo,
    folderWorkspaces
  })
}

function MoveLabel(): string {
  return translate(
    'components.tab.bar.MoveTerminalToWorktreeMenuSection.moveToWorktree',
    'Move to worktree…'
  )
}

export function MoveTerminalToWorktreeDropdownSection({
  tabId,
  sourceWorktreeId
}: {
  tabId: string
  sourceWorktreeId: string
}): React.JSX.Element | null {
  const destinations = useTerminalMoveDestinations(sourceWorktreeId)
  const moveTerminalTabToWorktree = useAppStore((s) => s.moveTerminalTabToWorktree)
  if (destinations.length === 0) {
    return null
  }
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className="[&>svg:last-child]:size-3.5">
        <FolderGit2 className="size-3.5 shrink-0" />
        {MoveLabel()}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className={TAB_CONTEXT_SUBMENU_CONTENT_CLASS}>
        {destinations.map((destination) => (
          <DropdownMenuItem
            key={destination.id}
            onSelect={() => {
              moveTerminalTabToWorktree(tabId, destination.id)
            }}
          >
            <FolderGit2 className="size-3.5 shrink-0" />
            {destination.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

export function MoveTerminalToWorktreeContextSection({
  tabId,
  sourceWorktreeId
}: {
  tabId: string
  sourceWorktreeId: string
}): React.JSX.Element | null {
  const destinations = useTerminalMoveDestinations(sourceWorktreeId)
  const moveTerminalTabToWorktree = useAppStore((s) => s.moveTerminalTabToWorktree)
  if (destinations.length === 0) {
    return null
  }
  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger className="[&>svg:last-child]:size-3.5">
        <FolderGit2 className="size-3.5 shrink-0" />
        {MoveLabel()}
      </ContextMenuSubTrigger>
      <ContextMenuSubContent className={TAB_CONTEXT_SUBMENU_CONTENT_CLASS}>
        {destinations.map((destination) => (
          <ContextMenuItem
            key={destination.id}
            onSelect={() => {
              moveTerminalTabToWorktree(tabId, destination.id)
            }}
          >
            <FolderGit2 className="size-3.5 shrink-0" />
            {destination.label}
          </ContextMenuItem>
        ))}
      </ContextMenuSubContent>
    </ContextMenuSub>
  )
}
