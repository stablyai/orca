import { ListFilter } from 'lucide-react'
import {
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator
} from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { botSidebarNameCollator } from '../../../../shared/bots/bot-sidebar-view'
import { SidebarOptionsPopover } from '../sidebar/worktree-list/controls/SidebarOptionsPopover'

export function BotSidebarTagFilter({
  availableTags,
  activeTags
}: {
  availableTags: ReadonlyMap<string, string>
  activeTags: ReadonlySet<string>
}): React.JSX.Element | null {
  const t = useTranslate()
  const setView = useAppStore((s) => s.setBotSidebarView)
  if (availableTags.size === 0) {
    return null
  }
  const count = activeTags.size
  const title = t('bots.tagFilter.label', 'Filter by tag')
  const label = count
    ? t('bots.tagFilter.active', 'Filter by tag ({{total}} selected)', { total: count })
    : title
  const tags = [...availableTags].sort(([, left], [, right]) =>
    botSidebarNameCollator.compare(left, right)
  )
  return (
    <SidebarOptionsPopover
      tooltip={title}
      ariaLabel={label}
      activeFilterCount={count}
      icon={ListFilter}
    >
      <DropdownMenuLabel>{title}</DropdownMenuLabel>
      {tags.map(([key, tag]) => (
        <DropdownMenuCheckboxItem
          key={key}
          checked={activeTags.has(key)}
          onSelect={(event) => event.preventDefault()}
          onCheckedChange={(checked) =>
            setView({
              tagFilter: checked
                ? [...activeTags, key]
                : [...activeTags].filter((tagKey) => tagKey !== key)
            })
          }
        >
          <span className="min-w-0 break-all">{tag}</span>
        </DropdownMenuCheckboxItem>
      ))}
      <DropdownMenuSeparator />
      <DropdownMenuItem disabled={count === 0} onSelect={() => setView({ tagFilter: [] })}>
        {t('bots.tagFilter.clear', 'Clear tag filter')}
      </DropdownMenuItem>
    </SidebarOptionsPopover>
  )
}
