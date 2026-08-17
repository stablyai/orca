import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '../store'
import { getStartupErrorFallbackUI } from '../lib/startup-ui-hydration'
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

// Why (issue #1158): reconnect flips workspaceSessionReady so the UI mounts, but pending* maps
// are normally drained by reconnect — clear them so a failure can't leave phantom dead PTYs.
function forceWorkspaceSessionReady(): void {
  useAppStore.setState({
    workspaceSessionReady: true,
    pendingReconnectWorktreeIds: [],
    pendingReconnectTabByWorktree: {},
    pendingReconnectPtyIdByTabId: {}
  })
}

/**
 * Boots the app in degraded "no-save" mode after the startup hydration chain threw.
 *
 * Why (issue #1158): in-memory state is left untouched and hydrationSucceeded stays false
 * (default-hydrating here once erased saved tabs); only the ready flags flip so the UI mounts.
 */
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
  // Why (issue #1158): only apply default UI if ui.get() never hydrated; otherwise defaults would clobber ui.json via the debounced writer.
  const fallbackUI = getStartupErrorFallbackUI(uiHydrated)
  if (fallbackUI) {
    hydratePersistedUI(fallbackUI, 'startup')
  }
  // Why (issue #1158): sticky toast so the user knows they're in degraded "no-save" mode (hydrationSucceeded stays false); "Restart now" calls app.relaunch to recover.
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
  if (reconnectStarted) {
    // Why (issue #1158): re-running reconnect over its partially-mutated state would double-set ptyIds and drain pending* twice — force the flag, clear pending*.
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
  } catch (reconnectErr) {
    console.error('[startup] reconnectPersistedTerminals failed in error path:', reconnectErr)
    // Why (issue #1158): the await may have run during StrictMode teardown; re-check cancellation so a cancelled pass 1 doesn't stomp pass 2's hydration.
    if (!isCancelled()) {
      // Why (issue #1158): recovery threw too; force the flag so the shell still mounts.
      forceWorkspaceSessionReady()
    }
  }
}
