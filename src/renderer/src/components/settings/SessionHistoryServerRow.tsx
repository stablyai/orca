import { useState } from 'react'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import { useConfirmationDialog } from '@/components/confirmation-dialog-context'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import {
  getRuntimeServerConnectionState,
  isRuntimeServerTransportConnected,
  type RuntimeHostDetails
} from './runtime-environment-host-details'
import { SessionHistoryComputerRow } from './SessionHistoryComputerRow'
import {
  isHostTooOldError,
  sessionSearchCheckingMessage,
  sessionSearchReadErrorMessage,
  sessionSearchStatusDetails,
  sessionSearchStatusMessage
} from './session-history-status-copy'
import { useSessionSearchStatus } from './use-session-search-status'

export function SessionHistoryServerRow({
  environment,
  details,
  onError
}: {
  environment: PublicKnownRuntimeEnvironment
  details: RuntimeHostDetails | undefined
  onError: (message: string | null) => void
}): React.JSX.Element {
  const hostId = toRuntimeExecutionHostId(environment.id)
  const confirm = useConfirmationDialog()
  const mounted = useMountedRef()
  const openSettingsPage = useAppStore((state) => state.openSettingsPage)
  const openSettingsTarget = useAppStore((state) => state.openSettingsTarget)
  const [tooOldOnSet, setTooOldOnSet] = useState(false)
  const [busy, setBusy] = useState(false)
  const connectionState = getRuntimeServerConnectionState(details)
  const connected = isRuntimeServerTransportConnected(connectionState)
  const { status, failed, hostTooOld, adopt } = useSessionSearchStatus({
    executionHostId: hostId,
    active: connected && !tooOldOnSet
  })
  // A status read or a set call can each prove the server predates session search.
  const tooOld = tooOldOnSet || hostTooOld
  const enabled = status?.enabled === true

  async function setEnabled(next: boolean): Promise<void> {
    setBusy(true)
    onError(null)
    try {
      adopt(await window.api.aiVault.setSearchEnabled(hostId, next))
    } catch (error) {
      if (!mounted.current) {
        return
      }
      if (isHostTooOldError(error)) {
        setTooOldOnSet(true)
        return
      }
      onError(
        translate(
          'sessionHistory.settings.serverToggleError',
          'Could not change session search on {{host}}. Try again.',
          { host: environment.name }
        )
      )
    } finally {
      if (mounted.current) {
        setBusy(false)
      }
    }
  }

  async function toggle(): Promise<void> {
    if (enabled) {
      await setEnabled(false)
      return
    }
    setBusy(true)
    let accepted = false
    try {
      accepted = await confirm({
        title: translate(
          'sessionHistory.settings.serverEnableTitle',
          'Turn on session search on {{host}}?',
          { host: environment.name }
        ),
        description: translate(
          'sessionHistory.settings.serverEnableConsent',
          'Orca will make the agent conversations and tool output on {{host}} searchable from Agent Session History. The searchable copy stays on {{host}}; results are sent to this computer when you search. The first pass runs in the background and can take a few minutes.',
          { host: environment.name }
        ),
        confirmLabel: translate('sessionHistory.settings.enableConfirm', 'Turn on')
      })
    } finally {
      if (mounted.current) {
        setBusy(false)
      }
    }
    if (!accepted || !mounted.current) {
      return
    }
    await setEnabled(true)
  }

  function openServerSettings(): void {
    openSettingsPage()
    openSettingsTarget({ pane: 'servers', repoId: null, sectionId: environment.id })
  }

  const row = {
    kind: 'server' as const,
    name: environment.name,
    version: details?.runtimeStatus?.appVersion ?? null,
    onToggle: () => void toggle()
  }
  if (tooOld) {
    return (
      <SessionHistoryComputerRow
        {...row}
        dimmed
        checked={false}
        disabled
        status={translate('sessionHistory.settings.serverTooOld', 'Needs a newer version of Orca.')}
        action={{
          label: translate('sessionHistory.settings.updateServer', 'Update server'),
          onClick: openServerSettings
        }}
      />
    )
  }
  if (!connected) {
    // Checking is not yet evidence of an unreachable host, so it does not claim the index was left behind.
    const checking = connectionState === 'checking'
    return (
      <SessionHistoryComputerRow
        {...row}
        dimmed={!checking}
        checked={enabled}
        disabled
        status={
          checking
            ? sessionSearchCheckingMessage()
            : translate('sessionHistory.settings.serverOffline', 'Offline')
        }
      />
    )
  }
  let statusText = sessionSearchCheckingMessage()
  if (failed) {
    statusText = sessionSearchReadErrorMessage()
  } else if (status) {
    statusText = enabled
      ? sessionSearchStatusMessage(status)
      : translate('sessionHistory.settings.serverOff', 'Off')
  }
  return (
    <SessionHistoryComputerRow
      {...row}
      checked={enabled}
      disabled={busy}
      status={statusText}
      details={sessionSearchStatusDetails(status)}
    />
  )
}
