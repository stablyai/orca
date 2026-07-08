import type React from 'react'
import { cn } from '@/lib/utils'
import { i18n, translate } from '@/i18n/i18n'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import type { AiVaultPromptDateGroup } from './ai-vault-prompt-timeline'
import { folderLabel } from './ai-vault-session-filters'
import { SessionTime } from './AiVaultSessionDetails'

export function AiVaultPromptTimeline({
  groups,
  loading,
  hasQuery,
  canResume,
  totalCount,
  shownCount,
  onResumeSession
}: {
  groups: AiVaultPromptDateGroup[]
  loading: boolean
  hasQuery: boolean
  canResume: boolean
  totalCount: number
  shownCount: number
  onResumeSession: (session: AiVaultSession) => void
}): React.JSX.Element {
  if (groups.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 py-10 text-center text-[12px] leading-5 text-muted-foreground">
        {loading
          ? translate('auto.components.right.sidebar.AiVaultPromptTimeline.loading', 'Loading prompts…')
          : hasQuery
            ? translate(
                'auto.components.right.sidebar.AiVaultPromptTimeline.noMatches',
                'No prompts match your search'
              )
            : translate(
                'auto.components.right.sidebar.AiVaultPromptTimeline.empty',
                'No prompts to the main agent yet'
              )}
      </div>
    )
  }

  return (
    <div className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto px-2.5 py-2">
      {groups.map((group) => (
        <section key={group.key} className="mb-3">
          <div className="sticky top-0 z-[1] mb-1.5 bg-sidebar/95 py-0.5 text-[10px] font-semibold uppercase tracking-[0.05em] text-muted-foreground backdrop-blur-sm">
            {groupLabel(group)}
          </div>
          <div className="space-y-1.5">
            {group.items.map((item, index) => (
              <button
                key={`${item.session.id}-${item.effectiveMs}-${index}`}
                type="button"
                disabled={!canResume}
                onClick={() => {
                  if (canResume) {
                    onResumeSession(item.session)
                  }
                }}
                title={
                  canResume
                    ? translate(
                        'auto.components.right.sidebar.AiVaultPromptTimeline.resumeHint',
                        'Resume this conversation'
                      )
                    : undefined
                }
                className={cn(
                  'block w-full rounded-md border border-sidebar-border/70 bg-background/50 px-2.5 py-2 text-left shadow-xs transition-colors',
                  canResume
                    ? 'hover:border-sidebar-ring/50 hover:bg-sidebar-accent/25'
                    : 'cursor-default'
                )}
              >
                <p className="line-clamp-2 text-[12px] leading-[1.35] text-foreground/90 [overflow-wrap:anywhere]">
                  {item.text}
                </p>
                <div className="mt-1 flex items-center gap-1.5 text-[10px] leading-4 text-muted-foreground">
                  <span className="min-w-0 truncate">{folderLabel(item.session.cwd)}</span>
                  <span className="shrink-0 text-muted-foreground/45">·</span>
                  <SessionTime value={item.timestamp ?? item.session.modifiedAt} />
                </div>
              </button>
            ))}
          </div>
        </section>
      ))}
      {totalCount > shownCount ? (
        <div className="px-1 py-2 text-center text-[10px] leading-4 text-muted-foreground">
          {translate(
            'auto.components.right.sidebar.AiVaultPromptTimeline.truncated',
            'Showing the {{value0}} most recent of {{value1}} prompts · narrow with search',
            { value0: shownCount, value1: totalCount }
          )}
        </div>
      ) : null}
    </div>
  )
}

function groupLabel(group: AiVaultPromptDateGroup): string {
  if (group.kind === 'today') {
    return translate('auto.components.right.sidebar.AiVaultPromptTimeline.today', 'Today')
  }
  if (group.kind === 'yesterday') {
    return translate('auto.components.right.sidebar.AiVaultPromptTimeline.yesterday', 'Yesterday')
  }
  try {
    // Localize with the app's resolved language (not the OS default).
    return new Intl.DateTimeFormat(i18n.language, {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    }).format(new Date(group.dateMs))
  } catch {
    return new Date(group.dateMs).toISOString().slice(0, 10)
  }
}
