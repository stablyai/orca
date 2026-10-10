import type React from 'react'
import { ListTodo } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { LinkedPluginTask } from '../../../../shared/plugins/plugin-task-link'

/** The plugin task a workspace was started from; opens it on the Tasks page. */
export function WorktreeCardPluginTaskLink({
  link
}: {
  link: LinkedPluginTask
}): React.JSX.Element {
  const openTaskPage = useAppStore((state) => state.openTaskPage)
  const label = translate(
    'auto.components.sidebar.WorktreeCard.openPluginTask',
    'Open in {{value0}}',
    {
      value0: link.sourceTitle
    }
  )
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-worktree-card-plugin-task=""
          aria-label={`${label}: ${link.title}`}
          onClick={(event) => {
            event.stopPropagation()
            openTaskPage({
              pluginTaskSource: { pluginKey: link.pluginKey, sourceId: link.sourceId },
              openPluginTaskItem: { id: link.itemId, title: link.title }
            })
          }}
          className="mt-0.5 flex min-w-0 max-w-full items-center gap-1 rounded-sm text-left text-[11px] leading-snug text-muted-foreground transition hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-worktree-sidebar-ring"
        >
          <ListTodo className="size-3 shrink-0" />
          <span className="truncate">{link.title}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
