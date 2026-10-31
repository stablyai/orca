import { useMemo } from 'react'
import { Plus } from 'lucide-react'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import { AgentStateDot } from '@/components/AgentStateDot'
import { AgentTypeIcon } from '@/lib/agent-type-icon'
import { formatShortTimeAgo } from '@/lib/short-time-ago'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useNow } from '@/hooks/use-now'
import { useOptionalShortcutLabel } from '@/hooks/useShortcutLabel'
import { useStructuredSessionSummaries } from '../native-chat/structured-session-summary-store'
import { getStructuredAgentSessionTabs } from '../native-chat/structured-agent-session-tabs'
import { structuredAgentSessionAgentStatus } from '../../../../shared/structured-agent-session-agent-status'
import { getAgentRowPrimaryText } from '../../../../shared/agent-row-primary-text'
import { openNewThread, selectThread } from './thread-actions'
import { useThreadNavigation } from './thread-navigation'

export function ThreadsSection(): React.JSX.Element {
  useUiLanguageRevision()
  const tabsByWorktree = useAppStore((s) => s.unifiedTabsByWorktree)
  const summaries = useStructuredSessionSummaries((s) => s.byTabId)
  const selected = useThreadNavigation((s) => s.selection)
  const activeView = useAppStore((s) => s.activeView)
  const shortcut = useOptionalShortcutLabel('thread.create')
  const rows = useMemo(
    () =>
      getStructuredAgentSessionTabs(tabsByWorktree)
        .flatMap((tab) => {
          const summary = summaries.get(tab.id)
          return summary?.surface === 'thread' ? [{ tab, summary }] : []
        })
        .sort(
          (a, b) => b.summary.updatedAt - a.summary.updatedAt || a.tab.id.localeCompare(b.tab.id)
        ),
    [tabsByWorktree, summaries]
  )
  const now = useNow(30_000, rows.length > 0)
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
        {rows.map(({ tab, summary }) => {
          const state =
            summary.status === null
              ? 'idle'
              : structuredAgentSessionAgentStatus({
                  ...summary,
                  status: summary.status,
                  childWork: summary.children ?? summary.backgroundTasks
                }).state
          const title =
            summary.conversationName ||
            getAgentRowPrimaryText({ prompt: summary.latestPrompt }) ||
            tab.label
          const current =
            activeView === 'terminal' && selected?.kind === 'thread' && selected.tabId === tab.id
          return (
            <button
              key={tab.id}
              type="button"
              data-current={current || undefined}
              aria-current={current ? 'page' : undefined}
              className={`flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-left text-xs text-muted-foreground hover:bg-sidebar-accent ${current ? 'bg-sidebar-accent text-foreground' : ''}`}
              onClick={() => selectThread(tab)}
            >
              <AgentStateDot state={state} size="sm" />
              <AgentTypeIcon agentType={summary.agent} size={13} />
              <span className="min-w-0 flex-1 truncate">{title}</span>
              <span className="text-3xs tabular-nums text-muted-foreground/60">
                {formatShortTimeAgo(summary.updatedAt, now)}
              </span>
            </button>
          )
        })}
        {rows.length === 0 ? (
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
