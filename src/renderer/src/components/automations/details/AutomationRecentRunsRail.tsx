import React from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/class-names'
import type { AutomationRun } from '../../../../../shared/automations/history/automation-run'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import {
  formatAutomationDateTime,
  getAutomationRunStatusLabel,
  AUTOMATION_EDITOR_SECTION_LABEL_CLASS
} from '../automation-page-parts'
import { AutomationOwnerConflictNotice } from '../hosts/AutomationOwnerConflictNotice'
import type { AutomationActionNotice } from '../hosts/automation-row-action-dispatch'
import type { AutomationHostRecoveryAction } from '../hosts/automation-host-status-descriptors'
import { formatAutomationRunLabel } from '../runs/automation-run-identity-label'
import { AutomationRunStatusDot } from '../runs/AutomationRunStatusDot'

const RECENT_RUN_LIMIT = 8

/** The newest runs beside the settings; each opens its run page. */
export function AutomationRecentRunsRail({
  runs,
  notice,
  onRecoverHistory,
  onOpenRun,
  onShowAllRuns,
  className
}: {
  /** Newest first. */
  runs: readonly AutomationRun[]
  /** Set when the history read failed; the runs are unknown, not zero. */
  notice: AutomationActionNotice | null
  onRecoverHistory: (action: AutomationHostRecoveryAction) => void
  onOpenRun: (run: AutomationRun) => void
  onShowAllRuns: () => void
  className?: string
}): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const recent = runs.slice(0, RECENT_RUN_LIMIT)
  return (
    <section
      aria-labelledby="automation-recent-runs-title"
      className={cn('min-w-0 rounded-lg border border-border/60', className)}
    >
      <h3
        id="automation-recent-runs-title"
        className={cn(
          'flex items-center justify-between border-b border-border/60 px-4 py-2.5 text-muted-foreground',
          AUTOMATION_EDITOR_SECTION_LABEL_CLASS
        )}
      >
        {t('auto.components.automations.recentRuns.title', 'Recent runs')}
        {notice ? null : <span className="font-normal tabular-nums">{runs.length}</span>}
      </h3>
      {notice ? (
        <div className="grid gap-2 px-4 py-3" data-testid="automation-run-history-failure">
          <p className="text-sm text-foreground">
            {t(
              'auto.components.automations.AutomationRunHistory.historyUnavailable',
              'Run history is unavailable from this host. This does not mean the automation failed or has no runs.'
            )}
          </p>
          <AutomationOwnerConflictNotice notice={notice} onRecover={onRecoverHistory} />
        </div>
      ) : recent.length === 0 ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">
          {t('auto.components.automations.AutomationRunHistory.402651bfb6', 'No runs yet.')}
        </p>
      ) : (
        <>
          <ul>
            {recent.map((run) => {
              const showStatus = run.status !== 'completed'
              return (
                <li key={run.id} className="border-b border-border/50 last:border-b-0">
                  <button
                    type="button"
                    data-automation-run-id={run.id}
                    onClick={() => onOpenRun(run)}
                    className="flex w-full min-w-0 items-center gap-2 px-4 py-2 text-left text-[13px] transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/50"
                  >
                    <AutomationRunStatusDot status={run.status} />
                    <span className="min-w-0 flex-1 truncate">
                      {formatAutomationRunLabel(run, t, intlLocale)}
                      {showStatus ? (
                        <span
                          className={cn(
                            'ml-1.5',
                            run.status === 'dispatch_failed'
                              ? 'text-destructive'
                              : 'text-muted-foreground'
                          )}
                        >
                          {getAutomationRunStatusLabel(run.status, t)}
                        </span>
                      ) : null}
                    </span>
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                      {formatAutomationDateTime(run.scheduledFor, t, intlLocale)}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
          <button
            type="button"
            data-automation-all-runs=""
            onClick={onShowAllRuns}
            className="flex w-full items-center gap-1 border-t border-border/50 px-4 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/50"
          >
            {t('auto.components.automations.recentRuns.allRuns', 'All {{count}} runs', {
              count: runs.length
            })}
            <ChevronRight aria-hidden="true" className="size-3.5" />
          </button>
        </>
      )}
    </section>
  )
}
