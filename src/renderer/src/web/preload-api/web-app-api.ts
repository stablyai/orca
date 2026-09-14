import type { PreloadApi } from '../../../../preload/api-types'
import { sanitizeWebRuntimeWorkspaceSession } from '../web-workspace-session'
import { sessionStorageKeyForHost } from './web-workspace-session-api'
import { mergeWebUIState } from './web-preference-normalization'
import { readLocalWebUIState } from './web-preferences-store'
import { UI_STORAGE_KEY, writeJson } from './web-storage'

export function createWebAppApi(): Partial<PreloadApi> {
  return {
    app: {
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
      relaunch: () => Promise.resolve(window.location.reload()),
      restart: () => Promise.resolve(window.location.reload()),
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
      recoverLegacyWorkerTerminalsForRendererStartup: () => Promise.resolve(),
      startupDiagnostic: () => Promise.resolve(),
      getKeyboardInputSourceId: () => Promise.resolve(null),
      // The web client cannot inspect local Mission Control shortcuts.
      getMacCapturedDigitRowChords: () => Promise.resolve([]),
      getKeyboardLayoutSnapshot: () => Promise.resolve(null),
      onKeyboardLayoutChanged: () => () => undefined,
      setUnreadDockBadgeCount: () => Promise.resolve(),
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
