import React from 'react'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Loader2, Trash2 } from 'lucide-react'
import { translate } from '@/i18n/i18n'

export type ReadOnlyProviderAccountRow = {
  id: string
  email: string
  /** Optional secondary line, e.g. Cursor membership tier. */
  detail?: string | null
}

type Props = {
  icon: React.ReactNode
  /** Provider display name (brand, not translated). */
  name: string
  description: string
  emptyLabel: string
  accounts: ReadOnlyProviderAccountRow[]
  activeAccountId: string | null
  /** Account id whose mutation is in flight, or null when idle. */
  busyAccountId: string | null
  onSelect: (accountId: string) => void
  onRemove: (accountId: string) => void
}

/**
 * Compact account section for read-only / scaffolded providers (Cursor,
 * MuseSpark). Unlike Claude/Codex there is no interactive login here — the
 * roster reflects whatever the provider is already signed into — so this only
 * offers switch + remove. Styling mirrors the primary provider rows.
 */
export function ReadOnlyProviderAccountsSection({
  icon,
  name,
  description,
  emptyLabel,
  accounts,
  activeAccountId,
  busyAccountId,
  onSelect,
  onRemove
}: Props): React.JSX.Element {
  const busy = busyAccountId !== null
  return (
    <section className="space-y-4 scroll-mt-6">
      <div className="space-y-1">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          {icon}
          {name}
        </h3>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>

      {accounts.length === 0 ? (
        <div className="rounded-md border border-dashed border-border/70 px-3 py-4 text-xs text-muted-foreground">
          {emptyLabel}
        </div>
      ) : (
        <div className="space-y-2">
          {accounts.map((account) => {
            const isActive = account.id === activeAccountId
            const isRemoving = busyAccountId === account.id
            return (
              <div
                key={account.id}
                className={`flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2.5 text-left transition-colors ${
                  isActive
                    ? 'border-foreground/20 bg-accent/15'
                    : 'border-border/70 hover:border-border hover:bg-accent/8'
                }`}
              >
                <button
                  type="button"
                  onClick={() => onSelect(account.id)}
                  disabled={busy}
                  className="flex min-w-0 flex-1 flex-col gap-0.5 text-left disabled:cursor-default"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm font-medium">{account.email}</span>
                    {isActive ? (
                      <Badge
                        variant="outline"
                        className="h-4 shrink-0 rounded px-1.5 text-[10px] font-medium leading-none text-foreground/80"
                      >
                        {translate('settings.accounts.readOnly.active', 'Active')}
                      </Badge>
                    ) : null}
                  </div>
                  {account.detail ? (
                    <span className="truncate text-[11px] text-muted-foreground">
                      {account.detail}
                    </span>
                  ) : null}
                </button>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => onRemove(account.id)}
                  disabled={busy}
                  aria-label={translate('settings.accounts.readOnly.remove', 'Remove account')}
                  className="shrink-0 text-muted-foreground hover:text-foreground"
                >
                  {isRemoving ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <Trash2 className="size-3" />
                  )}
                </Button>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
