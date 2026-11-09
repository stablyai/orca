import React from 'react'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import { normalizeRuntimePortForwardSettings } from '../../../../shared/runtime-port-forwards'

/** Empty Ports copy for a remote host: says whether new servers will be forwarded here. */
export function RuntimePortsEmptyText(): React.JSX.Element {
  const t = useTranslate()
  const autoForward = useAppStore(
    (s) => normalizeRuntimePortForwardSettings(s.settings?.runtimePortForwarding).autoForward
  )
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  if (autoForward) {
    return (
      <>
        {t(
          'auto.components.right.sidebar.PortsPanel.remoteEmpty',
          'No ports yet. Dev servers started here are forwarded to localhost.'
        )}
      </>
    )
  }
  return (
    <>
      {t(
        'auto.components.right.sidebar.PortsPanel.remoteEmptyOff',
        'No ports yet. Auto-forward is off.'
      )}{' '}
      <button
        type="button"
        className="rounded-sm text-foreground underline underline-offset-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        onClick={() => openSettingsTarget({ pane: 'ports', repoId: null })}
      >
        {t('auto.components.right.sidebar.PortsPanel.portsSettings', 'Ports settings')}
      </button>
    </>
  )
}
