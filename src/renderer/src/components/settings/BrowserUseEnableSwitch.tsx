import { translate } from '@/i18n/i18n'
export function BrowserUseEnableSwitch({
  enabled,
  onToggle
}: {
  enabled: boolean
  onToggle: () => void
}): React.JSX.Element {
  return (
    <button
      role="switch"
      aria-checked={enabled}
      aria-label={translate(
        'auto.components.settings.BrowserUseEnableSwitch.aea3f45349',
        'Enable Agent Browser Use'
      )}
      onClick={onToggle}
      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
        enabled ? 'bg-foreground' : 'bg-muted-foreground/30'
      }`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 transform rounded-full bg-background shadow-sm transition-transform ${
          enabled ? 'translate-x-4' : 'translate-x-0.5'
        }`}
      />
    </button>
  )
}
