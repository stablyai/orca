import { Monitor } from 'lucide-react'
import React from 'react'
import { translate } from '@/i18n/i18n'
import { splitEmailForDisplay } from './account-switch-row-model'

function accountInitials(email: string | null): string {
  if (!email) {
    return ''
  }
  const parts = splitEmailForDisplay(email)
    .local.split(/[-_.+]/)
    .filter(Boolean)
  const first = parts[0] ?? ''
  const second = parts[1]?.[0] ?? first[1] ?? ''
  return `${first[0] ?? ''}${second}`.toUpperCase()
}

/** The current account, shown above its usage so the numbers have an owner. */
export function AccountIdentityHeader({
  email,
  systemDefaultEmail,
  workspace,
  identifier
}: {
  email: string | null
  systemDefaultEmail?: string | null
  workspace: string | null
  identifier: string | null
}): React.JSX.Element {
  const secondary = [systemDefaultEmail, workspace, identifier].filter(Boolean).join(' · ')
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <span
        aria-hidden
        className="flex size-7 shrink-0 items-center justify-center rounded-full border border-border bg-background text-2xs font-medium text-muted-foreground"
      >
        {email ? accountInitials(email) : <Monitor className="size-3.5" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium text-foreground">
          {email ?? translate('auto.components.status.bar.StatusBar.c676918adc', 'System default')}
        </div>
        {secondary ? (
          <div className="truncate text-2xs text-muted-foreground">{secondary}</div>
        ) : null}
      </div>
    </div>
  )
}
