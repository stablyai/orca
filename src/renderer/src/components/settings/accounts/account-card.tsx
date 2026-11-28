import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import { Badge } from '../../ui/badge'

const TAG_VARIANTS = {
  active: 'accountTag',
  runtime: 'accountRuntimeTag',
  attention: 'accountAttentionTag'
} as const

/** A small tag after an account card's name: its runtime, Active, or a sign-in to fix. */
export function AccountCardTag({
  tone,
  children
}: {
  tone: keyof typeof TAG_VARIANTS
  children: React.ReactNode
}): React.JSX.Element {
  return <Badge variant={TAG_VARIANTS[tone]}>{children}</Badge>
}

/** Stands in for account cards while there are none to show, such as no saved accounts yet. */
export function AccountCardPlaceholder({
  children
}: {
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="rounded-md border border-dashed border-border/70 px-3 py-4 text-xs text-muted-foreground">
      {children}
    </div>
  )
}

/** One saved account in Settings → Accounts. With `onSelect` the whole card picks it; its actions
 *  sit on top and keep their own clicks. `attention` marks something the user must fix, and as a
 *  string also tags the card with it. */
export function AccountCard({
  title,
  tags,
  active = false,
  attention,
  detail,
  actions,
  onSelect,
  selectDisabled = false
}: {
  title: React.ReactNode
  /** Tags before Active, such as the account's runtime. */
  tags?: React.ReactNode
  active?: boolean
  attention?: boolean | string
  detail?: React.ReactNode
  actions?: React.ReactNode
  onSelect?: () => void
  selectDisabled?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const body = (
    <>
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate text-sm font-medium">{title}</span>
        {tags}
        {active ? (
          <AccountCardTag tone="active">
            {t('auto.components.settings.AccountsPane.e74831fb6b', 'Active')}
          </AccountCardTag>
        ) : null}
        {typeof attention === 'string' ? (
          <AccountCardTag tone="attention">{attention}</AccountCardTag>
        ) : null}
      </div>
      {detail ? (
        <div
          className={cn(
            'flex min-w-0 items-center gap-1.5 text-2xs max-sm:flex-wrap',
            attention ? 'text-destructive' : 'text-muted-foreground'
          )}
        >
          {detail}
        </div>
      ) : null}
    </>
  )
  return (
    <div
      className={cn(
        'relative rounded-md border px-3 py-2.5 transition-colors',
        attention
          ? 'border-destructive/50 bg-destructive/5'
          : active
            ? 'border-foreground/20 bg-accent/15'
            : cn('border-border/70', onSelect && 'hover:border-border hover:bg-accent/8')
      )}
    >
      <div className="flex w-full items-center justify-between gap-3 max-md:flex-col max-md:items-start">
        {onSelect ? (
          <button
            type="button"
            onClick={onSelect}
            disabled={selectDisabled}
            // The stretched hit area makes the card's padding pick the account too.
            className="flex min-w-0 flex-1 flex-col gap-0.5 text-left max-md:w-full after:absolute after:inset-0 after:rounded-md disabled:cursor-default"
          >
            {body}
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 flex-col gap-0.5 max-md:w-full">{body}</div>
        )}
        {actions ? (
          <div className="relative flex shrink-0 items-center justify-end gap-1 max-md:w-full max-md:flex-wrap">
            {actions}
          </div>
        ) : null}
      </div>
    </div>
  )
}
