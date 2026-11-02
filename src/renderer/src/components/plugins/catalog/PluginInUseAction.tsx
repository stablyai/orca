import { translate } from '@/i18n/i18n'
import { Button } from '../../ui/button'
import { switchToPluginLanguage } from '../page/PluginContributionActionLanguage'
import { applyPluginThemesNow } from '../state/plugin-theme-apply'
import type { PluginInUse } from '../state/use-plugin-in-use'

function inUseLabel(slot: 'light' | 'dark' | null): string {
  return slot === 'dark'
    ? translate('auto.components.settings.PluginInUseAction.inUseDark', 'In use · Dark')
    : slot === 'light'
      ? translate('auto.components.settings.PluginInUseAction.inUseLight', 'In use · Light')
      : translate('auto.components.settings.PluginInUseAction.inUse', 'In use')
}

/** "In use" when a plugin's theme, icon theme or language is the active one, else "Use". */
export function PluginInUseAction({
  pluginKey,
  name,
  inUse,
  size = 'xs'
}: {
  pluginKey: string
  name: string
  inUse: PluginInUse
  size?: 'xs' | 'sm'
}): React.JSX.Element | null {
  if (!inUse) {
    return null
  }
  if (inUse.kind === 'in-use') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs whitespace-nowrap text-muted-foreground">
        <span aria-hidden="true" className="size-1.5 rounded-full bg-status-success" />
        {inUseLabel(inUse.slot)}
      </span>
    )
  }
  const pack = inUse.languagePack
  return (
    <Button
      variant="outline"
      size={size}
      aria-label={translate(
        'auto.components.settings.PluginInUseAction.useName',
        'Use {{value0}}',
        {
          value0: name
        }
      )}
      onClick={() => void (pack ? switchToPluginLanguage(pack) : applyPluginThemesNow(pluginKey))}
    >
      {translate('auto.components.settings.PluginInUseAction.use', 'Use')}
    </Button>
  )
}
