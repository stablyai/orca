import { UserRound } from 'lucide-react'
import React from 'react'

export function AccountIdentityHeader({ label }: { label: string }): React.JSX.Element {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <span
        aria-hidden
        className="flex size-7 shrink-0 items-center justify-center rounded-full border border-border bg-background text-muted-foreground"
      >
        <UserRound className="size-3.5" />
      </span>
      <span className="min-w-0 truncate text-sm font-medium">{label}</span>
    </div>
  )
}
