// The S0 row frame (spec §5): agent heading, status glyph, two text lines and one action slot.
import type React from 'react'
import { CircleAlert, CircleCheck, Info, Loader2, TriangleAlert } from 'lucide-react'
import { getIntlLocale } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { formatElapsedTime } from '@/components/worktree-creation/worktree-creation-clock'
import type { OrcaCloudAccountAgent } from '../../../../../shared/orca-cloud-agents/orca-cloud-agents-wire'
import { agentName } from './orca-cloud-accounts-copy'

export function formatDate(value: number): string {
  return new Intl.DateTimeFormat(getIntlLocale(), { dateStyle: 'medium' }).format(value)
}

export function StatusIcon({
  tone
}: {
  tone: 'done' | 'busy' | 'warning' | 'info' | 'none' | 'error'
}): React.JSX.Element {
  const base = 'mt-0.5 size-4 shrink-0'
  switch (tone) {
    case 'done':
      return <CircleCheck aria-hidden className={cn(base, 'text-muted-foreground')} />
    case 'busy':
      // Reduced motion stops the spin; the words carry the state.
      return (
        <Loader2
          aria-hidden
          className={cn(base, 'text-muted-foreground motion-safe:animate-spin')}
        />
      )
    case 'warning':
      return <TriangleAlert aria-hidden className={cn(base, 'text-status-warning-text')} />
    case 'error':
      return <CircleAlert aria-hidden className={cn(base, 'text-destructive')} />
    case 'info':
      return <Info aria-hidden className={cn(base, 'text-muted-foreground')} />
    case 'none':
      return <span aria-hidden className={base} />
  }
}

export function RowShell({
  agent,
  tone,
  title,
  detail,
  detailTone = 'muted',
  actions,
  children
}: {
  agent: OrcaCloudAccountAgent
  tone: React.ComponentProps<typeof StatusIcon>['tone']
  title: React.ReactNode
  detail?: React.ReactNode
  detailTone?: 'muted' | 'warning'
  actions?: React.ReactNode
  children?: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <li
      data-orca-cloud-account={agent}
      className="grid min-h-16 grid-cols-[5rem_minmax(0,1fr)] items-center gap-x-4 border-t border-border py-3 first:border-t-0"
    >
      <h4 className="text-sm font-medium text-foreground">{agentName(agent, t)}</h4>
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex min-w-0 flex-1 items-start gap-2">
            <StatusIcon tone={tone} />
            <div className="min-w-0 space-y-0.5">
              <div className="text-sm text-foreground">{title}</div>
              {detail ? (
                <p
                  className={cn(
                    'text-xs',
                    detailTone === 'warning' ? 'text-status-warning-text' : 'text-muted-foreground'
                  )}
                >
                  {detail}
                </p>
              ) : null}
            </div>
          </div>
          {/* One action slot per row: focus stays here through every state. */}
          {actions ? (
            <div className="flex shrink-0 items-center gap-1.5" data-row-actions="">
              {actions}
            </div>
          ) : null}
        </div>
        {/* Aligned with the text: icon (16px) + gap (8px). */}
        {children ? <div className="pl-6">{children}</div> : null}
      </div>
    </li>
  )
}

function useElapsed(startedAt: number, now: number): string {
  return formatElapsedTime(Math.max(0, now - startedAt))
}

export function ElapsedSuffix({
  startedAt,
  now
}: {
  startedAt: number
  now: number
}): React.JSX.Element {
  const elapsed = useElapsed(startedAt, now)
  return <span className="text-muted-foreground tabular-nums"> · {elapsed}</span>
}
