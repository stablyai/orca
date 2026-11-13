import React from 'react'
import { cn } from '@/lib/class-names'

/**
 * CHAT-RENEW-INPLACE: the strip's quiet "Renew in Settings" link, at the end of the actions row, or on
 * its own line under the buttons in the narrow stack (design-squad).
 */
export function CloudStripSettingsLink({
  label,
  onOpen,
  ownLine = false
}: {
  label: string
  onOpen?: () => void
  ownLine?: boolean
}): React.JSX.Element | null {
  if (!onOpen) {
    return null
  }
  return (
    <button
      type="button"
      data-strip-settings-link
      onClick={onOpen}
      className={cn(
        'shrink-0 cursor-pointer text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline',
        'rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring',
        ownLine && 'basis-full text-left'
      )}
    >
      {label}
    </button>
  )
}
