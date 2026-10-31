import { CheckCircle2, CircleDashed, MinusCircle, PlayCircle, XCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { actionsStatusLabel } from './actions-status-label'
import { actionsStatusTone, ACTIONS_STATUS_TEXT_CLASSES } from './actions-status-tone'

/** Pair localized status text with semantic colors and accessible labels when only an icon is shown. */
export function ActionsStatus({
  status,
  pill = false,
  iconOnly = false,
  showIcon = true
}: {
  status: string | null | undefined
  pill?: boolean
  iconOnly?: boolean
  showIcon?: boolean
}) {
  const tone = actionsStatusTone(status)
  const Icon =
    tone === 'success'
      ? CheckCircle2
      : tone === 'failure'
        ? XCircle
        : tone === 'running'
          ? PlayCircle
          : tone === 'waiting'
            ? CircleDashed
            : status === 'completed' || status === null || status === undefined
              ? CircleDashed
              : MinusCircle
  const label = actionsStatusLabel(status ?? null)
  return (
    <span
      data-actions-status={status ?? 'unknown'}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 text-xs',
        ACTIONS_STATUS_TEXT_CLASSES[tone],
        pill && 'rounded-full border border-current/25 px-2 py-0.5 font-medium'
      )}
      aria-label={iconOnly ? label : undefined}
    >
      {showIcon && <Icon className="size-3.5 shrink-0" aria-hidden="true" />}
      {!iconOnly && label}
    </span>
  )
}
