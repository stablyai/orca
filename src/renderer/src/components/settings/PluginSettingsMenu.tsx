import { Ellipsis, FolderCog, Globe } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { PluginAddMenu } from './PluginAddMenu'

/** Set-once plugin preferences, kept out of the catalog's way. */
export function PluginSettingsMenu({
  featureEnabled,
  suggestionsEnabled,
  onToggleSuggestions,
  onSources,
  onDevelopment
}: {
  featureEnabled: boolean
  suggestionsEnabled: boolean
  onToggleSuggestions: () => void
  onSources: () => void
  onDevelopment: () => void
}): React.JSX.Element {
  const label = translate('auto.components.settings.PluginSettingsMenu.label', 'Plugin settings')
  return (
    <DropdownMenu>
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
          className="items-start"
        >
          <span className="min-w-0">
            <span className="block">
              {translate(
                'auto.components.settings.PluginsSettingsSection.fileTypeSuggestionsLabel',
                'Suggest plugins for unknown files'
              )}
            </span>
            <span className="block text-muted-foreground">
              {translate(
                'auto.components.settings.PluginsSettingsSection.fileTypeSuggestionsDescription',
                'Offer a catalog plugin when Orca can’t open or highlight a file.'
              )}
            </span>
          </span>
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={!featureEnabled} onSelect={onSources}>
          <Globe />
          {translate('auto.components.settings.PluginAddMenu.sources', 'Catalog sources…')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onDevelopment}>
          <FolderCog />
          {translate(
            'auto.components.settings.PluginSettingsMenu.development',
            'Development folders…'
          )}
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
