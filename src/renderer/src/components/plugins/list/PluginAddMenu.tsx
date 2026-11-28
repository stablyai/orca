import { ChevronDown, Folder, GitBranch, Plus } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '../../ui/button'
import { RAIL_PAGE_HIDE_NARROW } from '@/components/rail-page/RailPageHeader'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '../../ui/dropdown-menu'

/** The rare ways to add a plugin outside the catalog: a folder or a Git URL. */
export function PluginAddMenu({
  disabled,
  onChoose,
  railPage = false
}: {
  disabled: boolean
  onChoose: (kind: 'local-path' | 'git') => void
  /** Rail page header sizing; the label hides when the page is narrow. */
  railPage?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const label = t('auto.components.settings.PluginAddMenu.add', 'Add plugin')
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size={railPage ? 'toolbar' : 'sm'}
          disabled={disabled}
          aria-label={label}
        >
          <Plus />
          {railPage ? <span className={RAIL_PAGE_HIDE_NARROW}>{label}</span> : label}
          <ChevronDown className="text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem onSelect={() => onChoose('local-path')}>
          <Folder />
          {t('auto.components.settings.PluginAddMenu.folder', 'From a folder…')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onChoose('git')}>
          <GitBranch />
          {t('auto.components.settings.PluginAddMenu.git', 'From a Git URL…')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
