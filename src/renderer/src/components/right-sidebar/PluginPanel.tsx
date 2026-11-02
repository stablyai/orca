import React, { useEffect, useMemo, useRef } from 'react'
import { isPluginPanelTabKey } from '../../../../shared/plugins/manifest/plugin-manifest'
import { PLUGIN_PANEL_FRAME_NAME_PREFIX } from '../../../../shared/plugins/frames/plugin-frame-bridge'
import { fillPluginPanelShell } from './plugin-panel-design-token-css'
import {
  PluginFrameView,
  usablePluginFrameGuest,
  type PluginFrameElement
} from './plugin-frame-element'
import { PluginDeclarativePanel } from './PluginDeclarativePanel'
import { usePluginFrameHost } from './use-plugin-frame-host'
import { usePluginFrameEntry } from './use-plugin-frame-entry'
import { reportPluginPanelFailure, useReportFramePanelDraw } from './use-plugin-panel-draw-report'
import { usePluginPanels, usePluginPanelsStore } from '@/store/plugin-panels'
import { translate } from '@/i18n/i18n'
import { isWebClientLocation } from '@/lib/web-client-location'

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
  const frameRef = useRef<PluginFrameElement | null>(null)
  const { entry, markUnresponsive, remountGone } = usePluginFrameEntry(
    'panel',
    panel?.pluginKey ?? null,
    panel?.id ?? null
  )
  const guest = usablePluginFrameGuest(entry.status === 'ready' ? entry.guest : undefined)
  const declarative = entry.status === 'ready' && entry.ui === 'components'
  const panelShell = entry.status === 'ready' && !guest && !declarative ? entry.html : null
  // Why memoized: a new srcdoc reloads the frame; theme changes arrive as messages instead.
  const panelDocument = useMemo(
    () => (panelShell ? fillPluginPanelShell(panelShell) : null),
    [panelShell]
  )
  const panelFrameKey = entry.status === 'ready' ? `${tabKey}:${entry.revision}` : null
  const { onFrameLoad } = usePluginFrameHost({
    surface: 'panel',
    frameRef,
    // Why null: a declarative panel's own host wires its hidden guest instead.
    frameKey: declarative ? null : panelFrameKey,
    sessionToken: entry.status === 'ready' ? entry.sessionToken : null,
    onUnresponsive: markUnresponsive,
    onGuestGone: remountGone
  })

  useEffect(() => {
    if (entry.status === 'ready') {
      setPanelHealth(tabKey, 'healthy')
    } else if (entry.status !== 'loading') {
      setPanelHealth(tabKey, 'error')
      reportPluginPanelFailure(
        tabKey,
        `the panel ${entry.status === 'error' ? 'could not be loaded' : 'stopped responding'}`
      )
    }
  }, [entry.status, setPanelHealth, tabKey])
  useReportFramePanelDraw(tabKey, frameRef, guest && !declarative ? guest.url : null)

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

  if (declarative) {
    return guest && panelFrameKey ? (
      <PluginDeclarativePanel
        // A dev save keeps the panel (last good tree, memory atoms) and swaps only its guest.
        key={guest.dev ? `${tabKey}:dev` : panelFrameKey}
        tabKey={tabKey}
        hotReload={guest.dev === true}
        panelId={panel.id}
        title={panel.title}
        guest={guest}
        frameKey={panelFrameKey}
        sessionToken={entry.sessionToken}
        onUnresponsive={markUnresponsive}
      />
    ) : (
      <PluginPanelMessage>
        {isWebClientLocation()
          ? translate(
              'auto.components.right.sidebar.PluginPanel.needsDesktop',
              'This panel runs only in the Orca desktop app.'
            )
          : translate(
              'auto.components.right.sidebar.PluginPanel.needsIsolatedFrames',
              'This panel is not available: it needs isolated plugin frames, which are turned off.'
            )}
      </PluginPanelMessage>
    )
  }

  return (
    <PluginFrameView
      key={panelFrameKey}
      frameRef={frameRef}
      guest={guest}
      name={`${PLUGIN_PANEL_FRAME_NAME_PREFIX}${tabKey}`}
      srcDoc={panelDocument ?? ''}
      onLoad={onFrameLoad}
      title={panel.title}
    />
  )
}

export default PluginPanel
