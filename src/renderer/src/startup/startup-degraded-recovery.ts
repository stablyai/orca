import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '../store'
import { getStartupErrorFallbackUI } from '../lib/startup-ui-hydration'
import {
  announceWebHostUnreachableAtStartup,
  isWebHostUnreachableAtStartup
} from './startup-web-host-unreachable'
import {
  announceWebPairingRefusedAtStartup,
  isWebPairingRefusedAtStartup
} from './startup-web-pairing-refused'
import {
  collectTerminalProviderSnapshotPtyIds,
  refreshTerminalProviderSnapshotCapabilities
} from '../components/terminal/terminal-provider-snapshot-capability'

type DegradedStartupRecoveryArgs = {
  error: unknown
  /** Whether ui.get() hydrated before the failure; false means defaults are safe to apply. */
  uiHydrated: boolean
  /** Whether the success path already began terminal reconnect over now-partial state. */
  reconnectStarted: boolean
  isCancelled: () => boolean
  hydratePersistedUI: ReturnType<typeof useAppStore.getState>['hydratePersistedUI']
  reconnectPersistedTerminals: (signal: AbortSignal) => Promise<void>
  abortSignal: AbortSignal
}

// Reconnect normally drains pending maps; clear on failure so ready UI cannot retain phantom dead PTYs (#1158).
function forceWorkspaceSessionReady(): void {
  useAppStore.setState({
    workspaceSessionReady: true,
    pendingReconnectWorktreeIds: [],
    pendingReconnectTabByWorktree: {},
    pendingReconnectPtyIdByTabId: {},
    // Release activation gate even on degraded boot or fallback terminals never seed.
    terminalStartupRestorationReady: true
  })
}

function announceDegradedStartup(): void {
  // Keep no-save warning sticky until restart recovers hydration (#1158).
  toast.error(translate('auto.App.12e77cf12b', 'Session restore failed'), {
    description: translate(
      'auto.App.0a9e810705',
      "Changes won't be saved until restart. Your previous tabs are safe on disk."
    ),
    duration: Infinity,
    dismissible: true,
    action: {
      label: translate('auto.App.caea5b51b9', 'Restart now'),
      onClick: () => {
        void window.api.app.relaunch()
      }
    }
  })
}

/** Enter interactive no-save mode without touching in-memory state/hydrationSucceeded; default hydration here once erased saved tabs (#1158). */
export async function recoverFromDegradedStartup(args: DegradedStartupRecoveryArgs): Promise<void> {
  const {
    error,
    uiHydrated,
    reconnectStarted,
    isCancelled,
    hydratePersistedUI,
    reconnectPersistedTerminals,
    abortSignal
  } = args
  const stepLabel = error instanceof Error && error.message ? error.message : String(error)
  console.error(
    '[startup] Workspace session hydration failed; leaving disk state untouched:',
    stepLabel,
    error
  )
  if (isCancelled()) {
    return
  }
  // Why: degraded mode stays interactive; later repo/runtime changes must not remain gated forever.
  useAppStore.setState({ startupWorktreeRefreshCompleted: true })
  // Apply defaults only if ui.get never hydrated or debounced writes clobber ui.json (#1158).
  const fallbackUI = getStartupErrorFallbackUI(uiHydrated)
  if (fallbackUI) {
    hydratePersistedUI(fallbackUI, 'startup')
  }
  const hostUnreachable = await isWebHostUnreachableAtStartup(error)
  if (isCancelled()) {
    return
  }
  if (hostUnreachable) {
    // Still no-save until the reload: the host's catalog never loaded, so saving now would prune it.
    announceWebHostUnreachableAtStartup(abortSignal)
  } else if (isWebPairingRefusedAtStartup(error)) {
    announceWebPairingRefusedAtStartup(error)
  } else {
    announceDegradedStartup()
  }
  if (reconnectStarted) {
    // Do not rerun partially applied reconnect: force readiness/clear pending maps to avoid duplicate PTY assignment/drain (#1158).
    forceWorkspaceSessionReady()
    return
  }
  try {
    await window.api.app.awaitFirstWindowStartupServices()
    await window.api.app.recoverLegacyWorkerTerminalsForRendererStartup()
    await refreshTerminalProviderSnapshotCapabilities(
      collectTerminalProviderSnapshotPtyIds(useAppStore.getState())
    )
    await reconnectPersistedTerminals(abortSignal)
    await window.api.app.recoverLegacyWorkerTerminalsForRendererStartup()
    // Reconnect does not set the success chain’s final flag; release restoration readers on degraded boot too.
    if (!isCancelled()) {
      useAppStore.setState({ terminalStartupRestorationReady: true })
    }
  } catch (reconnectErr) {
    console.error('[startup] reconnectPersistedTerminals failed in error path:', reconnectErr)
    // Recheck cancellation after await so torn-down StrictMode pass cannot overwrite the next hydration (#1158).
    if (!isCancelled()) {
      // Recovery failed too; force shell readiness (#1158).
      forceWorkspaceSessionReady()
    }
  }
}
