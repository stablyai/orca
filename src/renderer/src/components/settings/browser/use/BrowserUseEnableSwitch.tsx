import { useTranslate } from '@/i18n/use-translate'
import { Switch } from '@/components/ui/switch'
export function BrowserUseEnableSwitch({
  enabled,
  onToggle
}: {
  enabled: boolean
  onToggle: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <Switch
      checked={enabled}
      aria-label={t(
        'auto.components.settings.BrowserUseEnableSwitch.ce4d6f80d8',
        'Enable agent browser use'
      )}
      onCheckedChange={onToggle}
    />
  )
}
