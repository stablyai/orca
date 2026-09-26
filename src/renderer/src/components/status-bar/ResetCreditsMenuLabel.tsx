import React from 'react'
import { DropdownMenuLabel } from '@/components/ui/dropdown-menu'

// Why: one shape for every provider's reset section so Claude and Codex menus stay aligned.
export function ResetCreditsMenuLabel({
  label,
  expiry
}: {
  label: string
  expiry: string | null
}): React.JSX.Element {
  return (
    <DropdownMenuLabel className="space-y-0.5">
      <div>{label}</div>
      {expiry ? (
        <div className="text-[11px] font-normal text-muted-foreground">{expiry}</div>
      ) : null}
    </DropdownMenuLabel>
  )
}
