import { translate } from '@/i18n/i18n'
import { useLeftNavigationPluginPanels } from '@/store/plugin-panels'
import PluginPanel from '@/components/right-sidebar/PluginPanel'

export function PluginMainPage({ tabKey }: { tabKey: `plugin:${string}` }): React.JSX.Element {
  const panels = useLeftNavigationPluginPanels()
  if (!panels.some((panel) => panel.tabKey === tabKey)) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
        {translate(
          'auto.components.right.sidebar.PluginPanel.unavailable',
          'This plugin panel is no longer available.'
        )}
      </div>
    )
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PluginPanel key={tabKey} tabKey={tabKey} />
    </div>
  )
}
