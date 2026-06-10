import type { JSX } from 'react'
import { Check } from 'lucide-react'
import { translate } from '@/i18n/i18n'

export function DeleteWorktreeSkipConfirmOption({
  showDontAskAgain,
  dontAskAgain,
  onToggleDontAskAgain
}: {
  showDontAskAgain: boolean
  dontAskAgain: boolean
  onToggleDontAskAgain: () => void
}): JSX.Element | null {
  if (!showDontAskAgain) {
    return null
  }

  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={dontAskAgain}
      onClick={onToggleDontAskAgain}
      className="flex items-center gap-2 rounded-sm px-1 py-1 text-xs text-foreground/80 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span
        className={`flex size-4 items-center justify-center rounded-sm border transition-colors ${
          dontAskAgain
            ? 'border-foreground bg-foreground text-background'
            : 'border-muted-foreground bg-transparent'
        }`}
      >
        {dontAskAgain ? <Check className="size-3" strokeWidth={3} /> : null}
      </span>
      {translate("auto.components.sidebar.DeleteWorktreeSkipConfirmOption.29aefb7e52", "Don't ask again")}</button>
  )
}
