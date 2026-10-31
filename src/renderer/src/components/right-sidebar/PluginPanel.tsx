import React, { useEffect, useMemo, useRef } from 'react'
import { isPluginPanelTabKey } from '../../../../shared/plugins/manifest/plugin-manifest'
import { PLUGIN_PANEL_FRAME_NAME_PREFIX } from '../../../../shared/plugins/frames/plugin-frame-bridge'
import { fillPluginPanelShell } from './plugin-panel-design-token-css'
import { usePluginFrameHost } from './use-plugin-frame-host'
import { usePluginFrameEntry } from './use-plugin-frame-entry'
import { usePluginPanels, usePluginPanelsStore } from '@/store/plugin-panels'
import { translate } from '@/i18n/i18n'

type PluginPanelProps = {
  tabKey: string
}

function PluginPanelMessage({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  )
}

function PluginPanel({ tabKey }: PluginPanelProps): React.JSX.Element {
  const panels = usePluginPanels()
  const setPanelHealth = usePluginPanelsStore((state) => state.setPanelHealth)
  const panel = isPluginPanelTabKey(tabKey)
    ? (panels.find((entry) => entry.tabKey === tabKey) ?? null)
    : null
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const { entry, markUnresponsive } = usePluginFrameEntry(
    'panel',
    panel?.pluginKey ?? null,
    panel?.id ?? null
  )
  const panelShell = entry.status === 'ready' ? entry.html : null
  // Why memoized: a new srcdoc reloads the frame; theme changes arrive as messages instead.
  const panelDocument = useMemo(
    () => (panelShell ? fillPluginPanelShell(panelShell) : null),
    [panelShell]
  )
  const panelFrameKey = entry.status === 'ready' ? `${tabKey}:${entry.revision}` : null
  const { onFrameLoad } = usePluginFrameHost({
    surface: 'panel',
    iframeRef,
    frameKey: panelFrameKey,
    sessionToken: entry.status === 'ready' ? entry.sessionToken : null,
    onUnresponsive: markUnresponsive
  })

  useEffect(() => {
    if (entry.status === 'ready') {
      setPanelHealth(tabKey, 'healthy')
    } else if (entry.status !== 'loading') {
      setPanelHealth(tabKey, 'error')
    }
  }, [entry.status, setPanelHealth, tabKey])

  // Persisted tabs can outlive an uninstalled or disabled plugin.
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

  if (entry.status === 'loading') {
    return (
      <PluginPanelMessage>
        {translate('auto.components.right.sidebar.PluginPanel.loading', 'Loading plugin panel...')}
      </PluginPanelMessage>
    )
  }

  if (entry.status === 'unresponsive') {
    return (
      <PluginPanelMessage>
        {translate(
          'auto.components.right.sidebar.PluginPanel.unresponsive',
          'This plugin panel stopped responding and was suspended.'
        )}
      </PluginPanelMessage>
    )
  }

  if (entry.status === 'error') {
    return (
      <PluginPanelMessage>
        {translate(
          'auto.components.right.sidebar.PluginPanel.loadFailed',
          'The plugin panel could not be loaded.'
        )}
      </PluginPanelMessage>
    )
  }

  return (
    <iframe
      key={panelFrameKey}
      ref={iframeRef}
      // SECURITY: never add allow-same-origin — the srcdoc frame must stay an
      // opaque origin so plugin UI cannot reach the app DOM, storage, or IPC.
      // The srcdoc itself is the host CSP shell wrapped around plugin HTML.
      sandbox="allow-scripts"
      name={`${PLUGIN_PANEL_FRAME_NAME_PREFIX}${tabKey}`}
      srcDoc={panelDocument ?? ''}
      onLoad={onFrameLoad}
      title={panel.title}
      className="min-h-0 w-full flex-1 border-0 bg-background"
    />
  )
}

export default PluginPanel
