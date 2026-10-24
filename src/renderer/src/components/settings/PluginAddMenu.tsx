import { ChevronDown, Folder, GitBranch, Plus } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'

/** The rare ways to add a plugin outside the catalog: a folder or a Git URL. */
export function PluginAddMenu({
  disabled,
  onChoose
}: {
  disabled: boolean
  onChoose: (kind: 'local-path' | 'git') => void
}): React.JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" disabled={disabled}>
          <Plus />
          {translate('auto.components.settings.PluginAddMenu.add', 'Add plugin')}
          <ChevronDown className="text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem onSelect={() => onChoose('local-path')}>
          <Folder />
          {translate('auto.components.settings.PluginAddMenu.folder', 'From a folder…')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onChoose('git')}>
          <GitBranch />
          {translate('auto.components.settings.PluginAddMenu.git', 'From a Git URL…')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
