import { memo } from 'react'
import { Plus } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import { AgentStateDot } from '@/components/AgentStateDot'
import { AgentTypeIcon } from '@/lib/agent-type-icon'
import { formatShortTimeAgo } from '@/lib/short-time-ago'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useNow } from '@/hooks/use-now'
import { useOptionalShortcutLabel } from '@/hooks/useShortcutLabel'
import {
  useStructuredSessionSummaries,
  useThreadRow
} from '../native-chat/structured-session-summary-store'
import { openNewThread, selectThread } from './thread-actions'
import { useDesktopThreadPage } from './use-desktop-thread-page'

export function ThreadsSection(): React.JSX.Element {
  useUiLanguageRevision()
  const ids = useStructuredSessionSummaries((s) => s.orderedIds)
  const selected = useDesktopThreadPage()
  const shortcut = useOptionalShortcutLabel('thread.create')
  const label = translate('threads.new', 'New thread')
  return (
    <section
      className="flex min-h-0 shrink-0 flex-col"
      aria-label={translate('threads.title', 'Threads')}
    >
      <div className="mt-2 flex h-8 shrink-0 items-center justify-between px-2">
        <span className="select-none pl-2 text-xs font-semibold text-muted-foreground/80">
          {translate('threads.title', 'Threads')}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground"
              aria-label={label}
              onClick={() => void openNewThread()}
            >
              <Plus className="size-3.5" strokeWidth={2.25} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{shortcut ? `${label} (${shortcut})` : label}</TooltipContent>
        </Tooltip>
      </div>
      <div className="worktree-sidebar-scrollbar max-h-56 overflow-y-auto px-2">
        {ids.map((id) => (
          <ThreadRow
            key={id}
            tabId={id}
            current={selected?.kind === 'thread' && selected.tabId === id}
          />
        ))}
        {ids.length === 0 ? (
          <p className="px-2 py-2 text-2xs text-muted-foreground">
            {shortcut
              ? translate(
                  'threads.empty.shortcut',
                  'No threads yet. Press {{shortcut}} to ask an agent anything.',
                  { shortcut }
                )
              : translate(
                  'threads.empty',
                  'No threads yet. Start a thread to ask an agent anything.'
                )}
          </p>
        ) : null}
      </div>
    </section>
  )
}

const ThreadRow = memo(function ThreadRow({ tabId, current }: { tabId: string; current: boolean }) {
  const row = useThreadRow(tabId)
  const now = useNow(30_000, !!row)
  if (!row?.tab) {
    return null
  }
  return (
    <button
      type="button"
      data-current={current || undefined}
      aria-current={current ? 'page' : undefined}
      className={`flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-left text-xs text-muted-foreground hover:bg-sidebar-accent ${current ? 'bg-sidebar-accent text-foreground' : ''}`}
      onClick={() => row.tab && selectThread(row.tab)}
    >
      <AgentStateDot state={row.state} size="sm" />
      <AgentTypeIcon agentType={row.agent} size={13} />
      <span className="min-w-0 flex-1 truncate">{row.title}</span>
      <span className="text-3xs tabular-nums text-muted-foreground/60">
        {formatShortTimeAgo(row.updatedAt, now)}
      </span>
    </button>
  )
})
