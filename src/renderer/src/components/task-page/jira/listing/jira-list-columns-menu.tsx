import { Columns3 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import {
  JIRA_LIST_COLUMNS,
  getJiraListColumnLabel,
  type JiraListColumnId
} from './jira-list-columns'

export function JiraListColumnsMenu({
  ids,
  onToggle
}: {
  ids: ReadonlySet<JiraListColumnId>
  onToggle: (column: JiraListColumnId) => void
}): React.JSX.Element {
  const t = useTranslate()
  const label = t('auto.components.TaskPage.jiraColumnsPicker', 'Columns')
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-xs" aria-label={label}>
              <Columns3 />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">{label}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        {JIRA_LIST_COLUMNS.filter((column) => !column.locked).map((column) => (
          <DropdownMenuCheckboxItem
            key={column.id}
            checked={ids.has(column.id)}
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={() => onToggle(column.id)}
          >
            {getJiraListColumnLabel(column.id, t)}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
