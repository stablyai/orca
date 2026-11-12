import { Ellipsis, FolderCog, Globe } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '../../ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '../../ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip'
import { PluginAddMenu } from './PluginAddMenu'

/** Set-once plugin preferences, kept out of the catalog's way. */
export function PluginSettingsMenu({
  featureEnabled,
  suggestionsEnabled,
  onToggleSuggestions,
  autoUpdateEnabled,
  onToggleAutoUpdate,
  open,
  onOpenChange,
  onSources,
  onDevelopment
}: {
  featureEnabled: boolean
  suggestionsEnabled: boolean
  onToggleSuggestions: () => void
  autoUpdateEnabled: boolean
  onToggleAutoUpdate: () => void
  open: boolean
  onOpenChange: (open: boolean) => void
  onSources: () => void
  onDevelopment: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const label = t('auto.components.settings.PluginSettingsMenu.label', 'Plugin settings')
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="icon-sm" aria-label={label}>
              <Ellipsis />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {label}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuCheckboxItem
          checked={suggestionsEnabled}
          onCheckedChange={onToggleSuggestions}
          onSelect={(event) => event.preventDefault()}
        >
          {t(
            'auto.components.settings.PluginsSettingsSection.fileTypeSuggestionsLabel',
            'Suggest plugins for unknown files'
          )}
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={autoUpdateEnabled}
          disabled={!featureEnabled}
          onCheckedChange={onToggleAutoUpdate}
          onSelect={(event) => event.preventDefault()}
          className="items-start"
        >
          <span className="min-w-0">
            <span className="block">
              {t(
                'auto.components.settings.PluginSettingsMenu.autoUpdateLabel',
                'Update plugins automatically'
              )}
            </span>
            <span className="block text-muted-foreground">
              {t(
                'auto.components.settings.PluginSettingsMenu.autoUpdateHint',
                'Asks again only for new access'
              )}
            </span>
          </span>
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={!featureEnabled} onSelect={onSources}>
          <Globe />
          {t('auto.components.settings.PluginAddMenu.sources', 'Catalog sources…')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onDevelopment}>
          <FolderCog />
          {t('auto.components.settings.PluginSettingsMenu.development', 'Development folders…')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The Plugins header: the rare ways to add a plugin, then its set-once settings. */
export function PluginsHeaderActions({
  onAdd,
  ...menu
}: React.ComponentProps<typeof PluginSettingsMenu> & {
  onAdd: (kind: 'local-path' | 'git') => void
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-1.5">
      <PluginAddMenu disabled={!menu.featureEnabled} onChoose={onAdd} />
      <PluginSettingsMenu {...menu} />
    </div>
  )
}
