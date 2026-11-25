import { AlertCircle, Check, ChevronDown, Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import {
  runAgentCliUpdateRow,
  type AgentCliUpdateRow
} from '../status-bar/updates/AgentCliUpdateList'
import { agentCliProductName } from './agent-cli-product-name'
import { rowFor, type RunTarget, type TargetPhase } from './agent-cli-update-card-run'
import { AgentCliUpdateFailedChip } from './AgentCliUpdateFailedChip'
import { openAgentCliUpdateFailure } from './agent-cli-update-failure-modal'
import { AgentCliUpdateCardReveal, AgentCliUpdateCardRow } from './AgentCliUpdateCardRows'

/** After Update all: one progress line, each CLI under it, then the result. */
export function AgentCliUpdateCardStrip({
  view,
  targets,
  phases,
  rows,
  detailsOpen,
  onToggleDetails,
  onRetry,
  onClose
}: {
  view: 'updating' | 'done' | 'failed'
  targets: readonly RunTarget[]
  phases: readonly TargetPhase[]
  rows: readonly AgentCliUpdateRow[]
  detailsOpen: boolean
  onToggleDetails: () => void
  onRetry: () => void
  onClose: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const done = phases.filter((phase) => phase === 'done').length
  const settled = phases.filter((phase) => phase !== 'running').length
  const failed = targets.filter((_, index) => phases[index] === 'failed')
  const [onlyTarget] = targets
  const [onlyFailed] = failed
  const label =
    view === 'updating'
      ? t('agentCliUpdate.statusUpdating', 'Updating CLIs')
      : view === 'done'
        ? targets.length === 1 && onlyTarget
          ? t('agentCliUpdate.cardDoneOne', '{{name}} is up to date', {
              name: agentCliProductName(onlyTarget.agent, t, 'short')
            })
          : t('agentCliUpdate.cardDone', 'All {{count}} CLIs are up to date', {
              count: targets.length,
              defaultValue_one: '{{count}} CLI is up to date'
            })
        : failed.length === 1 && onlyFailed
          ? t('agentCliUpdate.cardFailedOne', '{{name}} didn’t update', {
              name: agentCliProductName(onlyFailed.agent, t, 'short')
            })
          : t('agentCliUpdate.cardFailed', '{{count}} CLIs didn’t update', {
              count: failed.length,
              defaultValue_one: '{{count}} CLI didn’t update'
            })

  return (
    <>
      <div className="relative flex h-11.5 items-center gap-2.5 pr-2 pl-3.5">
        <span className="flex size-4.5 shrink-0 items-center justify-center">
          {view === 'updating' ? (
            <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
          ) : view === 'done' ? (
            <span className="flex size-4.5 items-center justify-center rounded-full bg-status-success text-white">
              <Check className="size-3" strokeWidth={3} />
            </span>
          ) : (
            <AlertCircle className="size-4 text-destructive" />
          )}
        </span>
        <span className="truncate text-[13px] font-medium" aria-live="polite">
          {label}
        </span>
        {view === 'updating' ? (
          <>
            <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
              {t('agentCliUpdate.cardProgress', '{{done}} of {{total}}', {
                done,
                total: targets.length
              })}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7 shrink-0"
              aria-expanded={detailsOpen}
              aria-label={t('agentCliUpdate.cardShowEach', 'Show each CLI')}
              onClick={onToggleDetails}
            >
              <ChevronDown
                className={cn(
                  'size-3.5 transition-transform duration-200 ease-out motion-reduce:transition-none',
                  detailsOpen && 'rotate-180'
                )}
              />
            </Button>
            <div className="absolute inset-x-0 bottom-0 h-0.5 bg-foreground/10" aria-hidden>
              <div
                className="h-full origin-left bg-foreground transition-transform duration-500 ease-out motion-reduce:transition-none"
                style={{ transform: `scaleX(${settled / Math.max(1, targets.length)})` }}
              />
            </div>
          </>
        ) : view === 'failed' ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="ml-auto size-7 shrink-0"
            onClick={onClose}
            aria-label={t('agentCliUpdate.cardDismiss', 'Dismiss')}
          >
            <X className="size-3.5" />
          </Button>
        ) : null}
      </div>
      <AgentCliUpdateCardReveal open={detailsOpen && view !== 'done'}>
        <div className={cn('mx-2 pt-1.5', view === 'failed' ? 'border-t border-border' : 'pb-2')}>
          {targets.map((target, index) => {
            const phase = phases[index]
            return (
              <AgentCliUpdateCardRow
                key={`${target.hostKey}\n${target.agent}`}
                agent={target.agent}
              >
                {phase === 'running' ? (
                  <>
                    <span>{t('agentCliUpdate.updating', 'Updating…')}</span>
                    <Loader2 className="size-3 animate-spin" />
                  </>
                ) : phase === 'failed' ? (
                  <AgentCliUpdateFailedChip
                    onOpen={() =>
                      openAgentCliUpdateFailure({
                        hostKey: target.hostKey,
                        agent: target.agent,
                        tryAgain: () => {
                          const row = rowFor(target, rows)
                          if (row) {
                            runAgentCliUpdateRow(row)
                          }
                        }
                      })
                    }
                  />
                ) : (
                  <>
                    <span>{target.to}</span>
                    <Check className="size-3.5 text-status-success" />
                  </>
                )}
              </AgentCliUpdateCardRow>
            )
          })}
        </div>
      </AgentCliUpdateCardReveal>
      {view === 'failed' ? (
        <div className="flex justify-end px-3.5 pt-3 pb-3.5">
          <Button type="button" size="sm" onClick={onRetry}>
            {t('agentCliUpdate.tryAgain', 'Try again')}
          </Button>
        </div>
      ) : null}
    </>
  )
}
