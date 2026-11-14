import {
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { CodeXml, SquareParking } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { requestManualTerminalWorktreePark } from '@/components/terminal-pane/parking/lifecycle/manual-terminal-worktree-parking'

export function WorktreeDeveloperMenu({
  worktreeId,
  disabled
}: {
  worktreeId: string
  disabled: boolean
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={disabled}>
        <CodeXml className="size-3.5" />
        {t('auto.components.sidebar.WorktreeDeveloperMenu.developer', 'Developer')}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-44">
        <DropdownMenuItem onSelect={() => requestManualTerminalWorktreePark(worktreeId)}>
          <SquareParking className="size-3.5" />
          {t('auto.components.sidebar.WorktreeDeveloperMenu.parkTerminal', 'Park terminal')}
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
