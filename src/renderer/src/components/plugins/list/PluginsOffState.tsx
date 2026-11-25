// @protected-copy: what turning plugins off does to their automations is not a language pack's to reword.
import { Puzzle } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'

/** Plugins are on by default; off only comes from a deliberate saved choice such as policy. */
export function PluginsOffState(): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border/50 bg-muted/40 py-2.5 pr-3 pl-4">
      <Puzzle className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">
          {t('auto.components.settings.PluginSettingsOverview.offTitle', 'Plugins are off')}
        </p>
        <p className="text-xs text-muted-foreground">
          {t(
            'auto.components.settings.PluginSettingsOverview.offAutomations',
            'Automations plugins created are paused, and stay paused when plugins are turned back on.'
          )}
        </p>
      </div>
    </div>
  )
}
