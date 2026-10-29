import { Blocks } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useOptionalShortcutLabel } from '@/hooks/useShortcutLabel'
import { openPluginsSettings } from '@/lib/open-plugins-settings'
import { translate } from '@/i18n/i18n'

export function PluginsStatusSegment(): React.JSX.Element {
  const shortcut = useOptionalShortcutLabel('view.plugins')
  const label = translate('auto.components.status.bar.PluginsStatusSegment.label', 'Plugins')

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="inline-flex cursor-pointer items-center rounded px-1 py-0.5 text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground"
          aria-label={label}
          onClick={openPluginsSettings}
        >
          <Blocks className="size-3" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6}>
        {shortcut ? `${label} (${shortcut})` : label}
      </TooltipContent>
    </Tooltip>
  )
}
