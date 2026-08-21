import {
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { CodeXml, SquareParking } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { requestManualTerminalWorktreePark } from '@/lib/manual-terminal-worktree-parking'

export function WorktreeDeveloperMenu({
  worktreeId,
  disabled
}: {
  worktreeId: string
  disabled: boolean
}): React.JSX.Element {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={disabled}>
        <CodeXml className="size-3.5" />
        {translate('auto.components.sidebar.WorktreeDeveloperMenu.developer', 'Developer')}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-44">
        <DropdownMenuItem onSelect={() => requestManualTerminalWorktreePark(worktreeId)}>
          <SquareParking className="size-3.5" />
          {translate('auto.components.sidebar.WorktreeDeveloperMenu.parkTerminal', 'Park terminal')}
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
