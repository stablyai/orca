import { useEffect, useState } from 'react'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import {
  getRuntimeServerConnectionState,
  isRuntimeServerTransportConnected,
  type RuntimeHostDetails
} from './runtime-environment-host-details'
import { SessionHistoryComputerRow } from './SessionHistoryComputerRow'
import type { SessionSearchComputerState } from './session-search-computer-rollup'
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
  refresh = 0,
  onError,
  onStateChange
}: {
  environment: PublicKnownRuntimeEnvironment
  details: RuntimeHostDetails | undefined
  /** Bumped by the pane after it changes this host from outside the row. */
  refresh?: number
  onError: (message: string | null) => void
  /** Lets the pane count and order computers it does not itself poll. */
  onStateChange?: (environmentId: string, state: SessionSearchComputerState) => void
}): React.JSX.Element {
  const hostId = toRuntimeExecutionHostId(environment.id)
  const mounted = useMountedRef()
  const openSettingsPage = useAppStore((state) => state.openSettingsPage)
  const openSettingsTarget = useAppStore((state) => state.openSettingsTarget)
  const [tooOldOnSet, setTooOldOnSet] = useState(false)
  const [busy, setBusy] = useState(false)
  const connectionState = getRuntimeServerConnectionState(details)
  const connected = isRuntimeServerTransportConnected(connectionState)
  const { status, failed, hostTooOld, adopt } = useSessionSearchStatus({
    executionHostId: hostId,
    active: connected && !tooOldOnSet,
    refresh
  })
  // A status read or a set call can each prove the server predates session search.
  const tooOld = tooOldOnSet || hostTooOld
  const enabled = status?.enabled === true
  const state = resolveServerState({
    tooOld,
    connected,
    checking: connectionState === 'checking',
    enabled,
    answered: Boolean(status)
  })

  useEffect(() => {
    onStateChange?.(environment.id, state)
  }, [environment.id, onStateChange, state])

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

  function toggle(): Promise<void> {
    return setEnabled(!enabled)
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
  // An off computer says so with its switch; a sentence repeating it is noise.
  let statusText: string | undefined = sessionSearchCheckingMessage()
  if (failed) {
    statusText = sessionSearchReadErrorMessage()
  } else if (status) {
    statusText = enabled ? sessionSearchStatusMessage(status) : undefined
  }
  return (
    <SessionHistoryComputerRow
      {...row}
      checked={enabled}
      disabled={busy}
      {...(statusText === undefined ? {} : { status: statusText })}
      details={sessionSearchStatusDetails(status)}
    />
  )
}

/** What the pane needs to count and order this row, from what the row already knows. */
function resolveServerState(args: {
  tooOld: boolean
  connected: boolean
  checking: boolean
  enabled: boolean
  answered: boolean
}): SessionSearchComputerState {
  if (args.tooOld) {
    return 'needs-update'
  }
  // A probe still in flight is not evidence of an unreachable host.
  if (args.checking) {
    return 'checking'
  }
  if (!args.connected) {
    return 'offline'
  }
  if (!args.answered) {
    return 'checking'
  }
  return args.enabled ? 'on' : 'off'
}
