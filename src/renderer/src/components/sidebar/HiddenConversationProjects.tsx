import { Eye } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'

export function HiddenConversationProjects({
  projects,
  onRestore
}: {
  projects: Record<string, string> | undefined
  onRestore?: (key: string, label: string) => void
}) {
  const entries = Object.entries(projects ?? {})
  if (!entries.length) {
    return null
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="xs">
          <Eye className="size-3.5" />
          {translate('projectConversations.hiddenProjects', 'Hidden projects')}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>
          {translate('projectConversations.keepFiles', 'Files and history are kept')}
        </DropdownMenuLabel>
        {entries.map(([key, label]) => (
          <DropdownMenuItem
            key={key}
            disabled={!onRestore}
            onSelect={() => onRestore?.(key, label)}
          >
            <Eye className="size-3.5" />
            <span className="max-w-64 truncate">
              {translate('projectConversations.restoreProject', 'Restore {{project}}', {
                project: label
              })}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
