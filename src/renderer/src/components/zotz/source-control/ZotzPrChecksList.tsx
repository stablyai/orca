import React from 'react'
import { CircleCheck, CircleDashed, CircleMinus, CircleX, Wrench } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SwitchIndicator } from '@/components/ui/switch'
import { LoadingSpinner } from '@/components/LoadingSpinner'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { openAppHttpLink } from '@/lib/browser/navigation/app-http-link-open'
import type { ZotzCheckKind, ZotzPrChecksMonitor } from './use-zotz-pr-checks'
import { setZotzPrAutofix } from './zotz-pr-autofix-store'

const LIST_LIMIT = 10

function CheckIcon({ kind }: { kind: ZotzCheckKind }): React.JSX.Element {
  switch (kind) {
    case 'failed':
      return <CircleX className="size-3.5 shrink-0 text-destructive" />
    case 'running':
      return <CircleDashed className="size-3.5 shrink-0 text-muted-foreground" />
    case 'passed':
      return <CircleCheck className="size-3.5 shrink-0 text-status-success" />
    case 'skipped':
      return <CircleMinus className="size-3.5 shrink-0 text-muted-foreground" />
  }
}

function Counter({
  icon,
  count,
  label,
  className
}: {
  icon: React.ReactNode
  count: number
  label: string
  className: string
}): React.JSX.Element {
  return (
    <span
      title={label}
      aria-label={label}
      className={cn(
        'inline-flex items-center gap-1 rounded-full border border-border px-1.5 py-px font-medium tabular-nums',
        className
      )}
    >
      {icon}
      {count}
    </span>
  )
}

/** Failed, running and passed checks as colored counters; zero counts stay out of the way. */
export function ZotzPrChecksSummary({
  monitor
}: {
  monitor: ZotzPrChecksMonitor
}): React.JSX.Element {
  const t = useTranslate()
  const { checks, counts } = monitor
  if (checks === null) {
    return (
      <span className="flex items-center gap-1.5">
        <LoadingSpinner className="size-3" />
        {t('zotz.prChecks.loading', 'Loading checks…')}
      </span>
    )
  }
  if (checks.length === 0) {
    return <span>{t('zotz.prChecks.none', 'No checks on this pull request')}</span>
  }
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap">
      {counts.failed > 0 ? (
        <Counter
          icon={<CircleX className="size-3" />}
          count={counts.failed}
          label={t('zotz.prChecks.failed', '{{count}} failed', { count: counts.failed })}
          className="text-destructive"
        />
      ) : null}
      {counts.running > 0 ? (
        <Counter
          icon={<LoadingSpinner className="size-3" />}
          count={counts.running}
          label={t('zotz.prChecks.running', '{{count}} running', { count: counts.running })}
          className="text-zotz-working-wave"
        />
      ) : null}
      {counts.passed > 0 ? (
        <Counter
          icon={<CircleCheck className="size-3" />}
          count={counts.passed}
          label={t('zotz.prChecks.passed', '{{count}} passed', { count: counts.passed })}
          className="text-status-success"
        />
      ) : null}
    </span>
  )
}

/** The checks, failed first, with the autofix switch and "Fix errors". */
export function ZotzPrChecksList({
  worktreeId,
  monitor,
  showSummary = true
}: {
  worktreeId: string
  monitor: ZotzPrChecksMonitor
  /** Off where the summary already sits in the surrounding header. */
  showSummary?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const visible = monitor.sorted.slice(0, LIST_LIMIT)
  return (
    <div className="space-y-2">
      {showSummary ? (
        <div className="text-xs text-muted-foreground">
          <ZotzPrChecksSummary monitor={monitor} />
        </div>
      ) : null}
      {visible.length > 0 ? (
        <ul className="scrollbar-sleek max-h-72 space-y-0.5 overflow-y-auto">
          {visible.map(({ check, kind }) => (
            <li key={`${check.name}-${check.checkRunId ?? check.url ?? ''}`}>
              <button
                type="button"
                disabled={!check.url}
                onClick={() => check.url && openAppHttpLink(check.url, { destination: 'system' })}
                className={cn(
                  'flex w-full min-w-0 items-center gap-2 rounded-md px-1 py-0.5 text-left text-xs',
                  check.url ? 'hover:bg-accent' : 'cursor-default'
                )}
              >
                <CheckIcon kind={kind} />
                <span className="min-w-0 truncate">{check.name}</span>
              </button>
            </li>
          ))}
          {monitor.sorted.length > visible.length ? (
            <li className="px-1 text-xs text-muted-foreground">
              {t('zotz.prChecks.more', '+{{count}} more', {
                count: monitor.sorted.length - visible.length
              })}
            </li>
          ) : null}
        </ul>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          role="switch"
          aria-checked={monitor.autofixEnabled}
          onClick={() => setZotzPrAutofix(worktreeId, !monitor.autofixEnabled)}
          className="group flex items-center gap-1.5 rounded-md text-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <SwitchIndicator checked={monitor.autofixEnabled} size="compact" />
          <span className="text-muted-foreground transition-colors group-hover:text-foreground">
            {t('zotz.prChecks.autofix', 'Autofix')}
          </span>
        </button>
        {monitor.counts.failed > 0 ? (
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={monitor.fixing}
            onClick={monitor.fix}
          >
            {monitor.fixing ? <LoadingSpinner className="size-3" /> : <Wrench className="size-3" />}
            {t('zotz.prChecks.fix', 'Fix errors')}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
