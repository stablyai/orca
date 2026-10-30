import { X } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { useLeftNavigationPluginPanels } from '@/store/plugin-panels'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import PluginPanel from '@/components/right-sidebar/PluginPanel'

export function PluginMainPage({ tabKey }: { tabKey: `plugin:${string}` }): React.JSX.Element {
  const panels = useLeftNavigationPluginPanels()
  const setActiveView = useAppStore((state) => state.setActiveView)
  const panel = panels.find((candidate) => candidate.tabKey === tabKey)
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={translate(
            'auto.components.plugins.PluginMainPage.close',
            'Close plugin page'
          )}
          onClick={() => setActiveView('terminal')}
        >
          <X />
        </Button>
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold">
            {panel?.title ??
              translate('auto.components.plugins.PluginMainPage.unavailableTitle', 'Plugin page')}
          </h1>
          {panel ? (
            <p className="truncate text-xs text-muted-foreground">{panel.pluginName}</p>
          ) : null}
        </div>
      </header>
      {panel ? (
        <PluginPanel key={tabKey} tabKey={tabKey} />
      ) : (
        <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
          {translate(
            'auto.components.right.sidebar.PluginPanel.unavailable',
            'This plugin panel is no longer available.'
          )}
        </div>
      )}
    </div>
  )
}
