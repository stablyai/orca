import type { PreloadApi } from '../../../../../preload/api-types'
import { sanitizeWebRuntimeWorkspaceSession } from '../workspaces/web-workspace-session'
import { sessionStorageKeyForHost } from '../workspaces/web-workspace-session-api'
import { mergeWebUIState, readLocalWebUIState } from '../preferences/web-ui-state'
import { UI_STORAGE_KEY, writeJson } from '../web-storage'

export function createWebAppApi(): Partial<PreloadApi> {
  return {
    app: {
      getWindowsAdministratorStatus: () => Promise.resolve(null),
      getMacosUpgradeSupport: () => Promise.resolve('unknown'),
      restartAsAdministrator: () =>
        Promise.reject(new Error('Administrator restart requires the Windows desktop app.')),
      getIdentity: () =>
        Promise.resolve({
          name: 'Orca',
          isDev: false,
          devLabel: null,
          devBranch: null,
          devWorktreeName: null,
          devRepoRoot: null,
          dockBadgeLabel: null
        }),
      getFeatureWallAssetBaseUrl: () => Promise.resolve('/'),
      setWindowMaterialSuppressed: () => Promise.resolve(),
      relaunch: () => Promise.resolve(window.location.reload()),
      restart: () => Promise.resolve(window.location.reload()),
      // The browser client never shows desktop install-on-quit recovery.
      quit: () => Promise.resolve(),
      reload: () => Promise.resolve(window.location.reload()),
      stageBeforeUnloadSync: ({ sessions, ui }) => {
        // Why: beforeunload cannot await the paired runtime, so the web adapter
        // guarantees immediate browser-local durability for the final snapshot.
        for (const { state, hostId } of sessions) {
          writeJson(sessionStorageKeyForHost(hostId), sanitizeWebRuntimeWorkspaceSession(state))
        }
        writeJson(UI_STORAGE_KEY, mergeWebUIState(readLocalWebUIState(), ui))
      },
      // Staging already wrote through to browser storage, so there is nothing left to join.
      awaitBeforeUnloadCheckpoint: () => Promise.resolve(),
      awaitFirstWindowStartupServices: () => Promise.resolve(),
      awaitGitEnvironmentStartupBarrier: () => Promise.resolve(),
      prepareTerminalStartupRestoration: () => Promise.resolve(),
      // The browser client has no runtime of its own.
      holdsStructuredAgentSessions: () => Promise.resolve(false),
      onStructuredAgentSessionsHeldChanged: () => () => undefined,
      recoverLegacyWorkerTerminalsForRendererStartup: () => Promise.resolve(),
      startupDiagnostic: () => Promise.resolve(),
      getKeyboardInputSourceId: () => Promise.resolve(null),
      // The web client cannot inspect local Mission Control shortcuts.
      getMacCapturedDigitRowChords: () => Promise.resolve([]),
      getKeyboardLayoutSnapshot: () => Promise.resolve(null),
      onKeyboardLayoutChanged: () => () => undefined,
      getFloatingTerminalCwd: () => Promise.resolve(''),
      getFloatingMarkdownDirectory: () => Promise.resolve(''),
      pickFloatingMarkdownDocument: () => Promise.resolve(null),
      pickFloatingWorkspaceDirectory: () => Promise.resolve(null),
      // Browser fallback has no app-owned userData dir; reject so the sentinel can't claim sensitive evidence was persisted.
      writeTerminalRenderDesyncEvidence: () =>
        Promise.reject(
          new Error('Terminal render evidence is unavailable in the browser fallback.')
        )
    }
  }
}
