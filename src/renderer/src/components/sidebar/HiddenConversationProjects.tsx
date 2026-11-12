import { Eye } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'

export function HiddenConversationProjects({
  projects,
  onRestore
}: {
  projects: Record<string, string> | undefined
  onRestore?: (key: string, label: string) => void
}) {
  const t = useTranslate()
  const entries = Object.entries(projects ?? {})
  if (!entries.length) {
    return null
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="xs">
          <Eye className="size-3.5" />
          {t('projectConversations.hiddenProjects', 'Hidden projects')}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>
          {t('projectConversations.keepFiles', 'Files and history are kept')}
        </DropdownMenuLabel>
        {entries.map(([key, label]) => (
          <DropdownMenuItem
            key={key}
            disabled={!onRestore}
            onSelect={() => onRestore?.(key, label)}
          >
            <Eye className="size-3.5" />
            <span className="max-w-64 truncate">
              {t('projectConversations.restoreProject', 'Restore {{project}}', {
                project: label
              })}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
