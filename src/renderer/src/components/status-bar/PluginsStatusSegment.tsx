import { Blocks } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { useShortcutKeyComboDetails } from '@/hooks/useShortcutLabel'
import { togglePluginsSettings } from '@/components/settings/navigation/open-plugins-settings'
import { useTranslate } from '@/i18n/use-translate'

export function PluginsStatusSegment(): React.JSX.Element {
  const t = useTranslate()
  const shortcut = useShortcutKeyComboDetails('view.plugins')
  const label = t('auto.components.settings.PluginsSettingsSection.title', 'Plugins')

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="inline-flex cursor-pointer items-center rounded px-1 py-0.5 text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground"
          aria-label={label}
          onClick={togglePluginsSettings}
        >
          <Blocks className="size-3" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        <span className="inline-flex items-center gap-2">
          {label}
          {shortcut.map((combo) => (
            <ShortcutKeyCombo
              key={`${combo.doubleTap}:${combo.keys.join('+')}`}
              keys={combo.keys}
              doubleTap={combo.doubleTap}
            />
          ))}
        </span>
      </TooltipContent>
    </Tooltip>
  )
}
