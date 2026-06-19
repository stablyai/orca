import type { JSX } from 'react'
import { cn } from '@/lib/utils'

type AiCommitPrSettingsSwitchProps = {
  checked: boolean
  label: string
  onToggle: () => void
}

export function AiCommitPrSettingsSwitch({
  checked,
  label,
  onToggle
}: AiCommitPrSettingsSwitchProps): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      onClick={onToggle}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors',
        checked ? 'bg-foreground' : 'bg-muted-foreground/30'
      )}
    >
      <span
        className={cn(
          'pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform',
          checked ? 'translate-x-4' : 'translate-x-0.5'
        )}
      />
    </button>
  )
}
