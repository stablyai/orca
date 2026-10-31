import type { ReactNode } from 'react'
import { Label } from '../ui/label'
import { Switch } from '../ui/switch'

export type NotificationSettingToggleProps = {
  label: string
  description: string
  checked: boolean
  onToggle: () => void
  disabled?: boolean
  icon?: ReactNode
  /** Defaults to `label`; set it when several switches share one visible label. */
  ariaLabel?: string
}

export function NotificationSettingToggle({
  label,
  description,
  checked,
  onToggle,
  disabled = false,
  icon,
  ariaLabel
}: NotificationSettingToggleProps): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div className="space-y-0.5">
        <div className="flex items-center gap-2">
          {icon}
          <Label>{label}</Label>
        </div>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch
        checked={checked}
        aria-label={ariaLabel ?? label}
        disabled={disabled}
        onCheckedChange={onToggle}
      />
    </div>
  )
}
