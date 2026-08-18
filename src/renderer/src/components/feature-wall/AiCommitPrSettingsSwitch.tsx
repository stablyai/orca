import type { JSX } from 'react'
import { Switch } from '@/components/ui/switch'

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
  return <Switch aria-label={label} checked={checked} onCheckedChange={onToggle} />
}
