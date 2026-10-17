import React, { useCallback } from 'react'
import { isPluginPanelTabKey } from '../../../../shared/plugins/plugin-manifest'
import { PluginPanelMessage, PluginSandboxFrame } from './PluginSandboxFrame'
import {
  usePluginPanels,
  usePluginPanelsStore,
  type PluginPanelHealth
} from '@/store/plugin-panels'
import { translate } from '@/i18n/i18n'

type PluginPanelProps = {
  tabKey: string
}

function PluginPanel({ tabKey }: PluginPanelProps): React.JSX.Element {
  const panels = usePluginPanels()
  const setPanelHealth = usePluginPanelsStore((state) => state.setPanelHealth)
  const panel = isPluginPanelTabKey(tabKey)
    ? (panels.find((entry) => entry.tabKey === tabKey) ?? null)
    : null
  const onHealthChange = useCallback(
    (health: PluginPanelHealth) => setPanelHealth(tabKey, health),
    [setPanelHealth, tabKey]
  )

  // Persisted plugin tabs can outlive their plugin (uninstalled/disabled);
  // render a graceful empty state instead of a broken frame.
  if (!panel) {
    return (
      <PluginPanelMessage>
        {translate(
          'auto.components.right.sidebar.PluginPanel.unavailable',
          'This plugin panel is no longer available.'
        )}
      </PluginPanelMessage>
    )
  }

  return (
    <PluginSandboxFrame
      pluginKey={panel.pluginKey}
      contributionId={panel.id}
      surface="panel"
      title={panel.title}
      frameId={tabKey}
      onHealthChange={onHealthChange}
    />
  )
}

export default PluginPanel
