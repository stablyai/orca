import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import { Badge } from '../../../ui/badge'

/** A settings row whose label selects the account, like Codex's account rows. */
export function AntigravityAccountRow({
  title,
  detail,
  active = false,
  badge,
  error,
  actions,
  onSelect,
  selectDisabled
}: {
  title: string | null
  detail?: React.ReactNode
  active?: boolean
  /** Shown in place of the Active badge. */
  badge?: React.ReactNode
  /** What went wrong with this row's last action, under its detail. */
  error?: string | null
  actions?: React.ReactNode
  onSelect?: () => void
  selectDisabled?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const label = (
    <>
      {title ? (
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium">{title}</span>
          {badge ??
            (active ? (
              <Badge variant="outline">{t('accounts.antigravity.active', 'Active')}</Badge>
            ) : null)}
        </span>
      ) : null}
      {detail ? (
        <span
          className={cn(
            'flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground',
            title && 'mt-0.5'
          )}
        >
          {detail}
        </span>
      ) : null}
      {error ? (
        <span role="alert" className="mt-1 text-xs text-destructive [overflow-wrap:anywhere]">
          {error}
        </span>
      ) : null}
    </>
  )
  return (
    <div data-settings-row="">
      <div
        className={cn(
          '-mx-5 flex min-h-14 items-center justify-between gap-4 px-5 py-3',
          onSelect && !selectDisabled && 'transition-colors hover:bg-accent/40'
        )}
      >
        {onSelect ? (
          <button
            type="button"
            onClick={onSelect}
            disabled={selectDisabled}
            className="flex min-w-0 flex-1 flex-col items-start text-left disabled:cursor-default"
          >
            {label}
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 flex-col items-start">{label}</div>
        )}
        {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
      </div>
    </div>
  )
}
