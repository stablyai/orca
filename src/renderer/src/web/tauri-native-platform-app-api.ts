import type { PreloadApi } from '../../../preload/api-types'
import type { AppApi, PlatformApi } from '../../../preload/api/app-api'
import type { RuntimeMobileSessionAgentTab } from '../../../shared/remote-runtime/session-graph/runtime-mobile-session-tab-contracts'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { createWebAppApi } from './preload-api/app/web-app-api'
import { createWebRuntimeApi } from './preload-api/runtime/web-runtime-api'
import { callRuntimeResult } from './runtime/client/web-runtime-calls'
import { getBrowserPlatform } from './preload-api/web-storage'
import type { MarkdownDocument } from '../../../shared/file-listing/file-document'
import type {
  WriteTerminalRenderDesyncEvidenceArgs,
  WriteTerminalRenderDesyncEvidenceResult
} from '../../../shared/terminal/diagnostics/terminal-render-desync-evidence'
import { invokeNative, invokePlugin, isTauriNativeHost } from './tauri-native-host'
import { translate } from '../i18n/i18n'
import { prepareAndInvokeAppRestart } from '../../../preload/renderer/restart/renderer-restart-wiring'

type TauriNativePlatformInfo = Awaited<ReturnType<PlatformApi['get']>>
type TauriNativeAppIdentity = Awaited<ReturnType<AppApi['getIdentity']>>

async function readNativePlatformInfo(): Promise<TauriNativePlatformInfo> {
  return invokeNative<TauriNativePlatformInfo>('poc_platform_info')
}

function fallbackPlatformInfo(): TauriNativePlatformInfo {
  return {
    platform: getBrowserPlatform(),
    osRelease: '',
    arch: '',
    shell: '',
    displayServer: null,
    windowMaterial: 'off'
  }
}

let cachedNativePlatformInfo: TauriNativePlatformInfo | undefined
let structuredSessionHeld: boolean | undefined
let structuredSessionSubscription: { unsubscribe: () => void } | null = null
let structuredSessionSubscriptionStart: Promise<void> | null = null
let structuredSessionRetryTimer: ReturnType<typeof setTimeout> | null = null
const structuredSessionHeldListeners = new Set<(held: boolean) => void>()

function isSessionTabsResult(
  value: unknown
): value is { snapshots?: RuntimeMobileSessionTabsResult[] } {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  if (!('snapshots' in value)) {
    return true
  }
  const snapshots = value.snapshots
  return (
    snapshots === undefined ||
    (Array.isArray(snapshots) &&
      snapshots.every(
        (snapshot) =>
          typeof snapshot === 'object' &&
          snapshot !== null &&
          'tabs' in snapshot &&
          Array.isArray(snapshot.tabs)
      ))
  )
}

function isAgentSessionTab(tab: unknown): tab is RuntimeMobileSessionAgentTab {
  return typeof tab === 'object' && tab !== null && 'type' in tab && tab.type === 'agent-session'
}

async function holdsTauriStructuredAgentSessions(): Promise<boolean> {
  try {
    const result = await callRuntimeResult<unknown>('session.tabs.listAll')
    if (!isSessionTabsResult(result)) {
      return false
    }
    return (result.snapshots ?? []).some((snapshot) => snapshot.tabs.some(isAgentSessionTab))
  } catch {
    // Runtime startup and first pairing happen before the renderer is mounted;
    // an unavailable inventory is not evidence that the sessions were deleted.
    return false
  }
}

async function refreshTauriStructuredAgentSessionSignal(): Promise<void> {
  const next = await holdsTauriStructuredAgentSessions()
  const changed = structuredSessionHeld !== undefined && structuredSessionHeld !== next
  structuredSessionHeld = next
  if (changed) {
    for (const listener of structuredSessionHeldListeners) {
      listener(next)
    }
  }
}

function stopTauriStructuredAgentSessionSubscription(): void {
  if (structuredSessionRetryTimer !== null) {
    clearTimeout(structuredSessionRetryTimer)
    structuredSessionRetryTimer = null
  }
  structuredSessionSubscription?.unsubscribe()
  structuredSessionSubscription = null
  structuredSessionSubscriptionStart = null
}

function scheduleTauriStructuredAgentSessionSubscription(): void {
  if (structuredSessionHeldListeners.size === 0 || structuredSessionRetryTimer !== null) {
    return
  }
  structuredSessionRetryTimer = setTimeout(() => {
    structuredSessionRetryTimer = null
    void startTauriStructuredAgentSessionSubscription()
  }, 500)
}

async function startTauriStructuredAgentSessionSubscription(): Promise<void> {
  if (
    structuredSessionHeldListeners.size === 0 ||
    structuredSessionSubscription ||
    structuredSessionSubscriptionStart
  ) {
    return structuredSessionSubscriptionStart ?? Promise.resolve()
  }
  const start = (async () => {
    try {
      const subscription = await createWebRuntimeApi().subscribe(
        { method: 'session.tabs.subscribeAll', params: {} },
        () => {
          void refreshTauriStructuredAgentSessionSignal().catch(() => {})
        }
      )
      if (structuredSessionHeldListeners.size === 0) {
        subscription.unsubscribe()
      } else {
        structuredSessionSubscription = subscription
      }
    } catch {
      scheduleTauriStructuredAgentSessionSubscription()
    }
  })()
  structuredSessionSubscriptionStart = start
  try {
    await start
  } finally {
    structuredSessionSubscriptionStart = null
  }
}

function onTauriStructuredAgentSessionsHeldChanged(callback: (held: boolean) => void): () => void {
  structuredSessionHeldListeners.add(callback)
  void refreshTauriStructuredAgentSessionSignal().catch(() => {})
  void startTauriStructuredAgentSessionSubscription()
  return () => {
    structuredSessionHeldListeners.delete(callback)
    if (structuredSessionHeldListeners.size === 0) {
      stopTauriStructuredAgentSessionSubscription()
    }
  }
}

export function createTauriNativePlatformApi(): Partial<PlatformApi> {
  if (!isTauriNativeHost()) {
    return {}
  }
  void readNativePlatformInfo().then((info) => {
    cachedNativePlatformInfo = info
  })
  return {
    get: () => {
      cachedNativePlatformInfo ??= fallbackPlatformInfo()
      void readNativePlatformInfo().then((info) => {
        cachedNativePlatformInfo = info
      })
      return cachedNativePlatformInfo
    }
  }
}

export function createTauriNativePlatformNamespaceApi(): Pick<PreloadApi, 'platform'> {
  const api = createTauriNativePlatformApi()
  return {
    platform: {
      get: () => api.get?.() ?? fallbackPlatformInfo()
    }
  }
}

export function createTauriNativeAppApi(): Partial<AppApi> {
  if (!isTauriNativeHost()) {
    return {}
  }
  // Resolve the installed checkpoint lazily to preserve state before replacing the native owner.
  const awaitBeforeUnloadCheckpoint = (): Promise<void> =>
    window.api?.app?.awaitBeforeUnloadCheckpoint?.() ?? Promise.resolve()
  const invokeRestart = (): Promise<void> =>
    prepareAndInvokeAppRestart(
      window,
      () => invokeNative('poc_relaunch'),
      awaitBeforeUnloadCheckpoint
    )
  return {
    ...createWebAppApi().app,
    getIdentity: () => invokeNative<TauriNativeAppIdentity>('poc_app_identity'),
    // Why native: Settings shows the same elevation row as Electron. The
    // Rust command runs the same bundled launcher probe, so the web null
    // fallback only applies off the Tauri host.
    getWindowsAdministratorStatus: () =>
      invokeNative<boolean | null>('poc_get_windows_administrator_status'),
    // Why native: the tour surface resolves tile art against this base.
    // Rust answers the same /@fs dev and file:// packaged shapes as
    // Electron, so the web / fallback only applies off the Tauri host.
    getFeatureWallAssetBaseUrl: () => invokeNative<string>('poc_get_feature_wall_asset_base_url'),
    // Why orcad: floating cwd, markdown directory and trust live in the owned runtime like
    // Electron main, so the web empty-string/null fallbacks only apply off the Tauri host.
    getFloatingTerminalCwd: (args) =>
      callRuntimeResult<string>('host.floating.getTerminalCwd', args ?? {}),
    getFloatingMarkdownDirectory: () =>
      callRuntimeResult<string>('host.floating.getMarkdownDirectory'),
    pickFloatingMarkdownDocument: async () => {
      const directory = await callRuntimeResult<string>('host.floating.getMarkdownDirectory')
      const picked = await invokePlugin<string | string[] | null>('dialog', 'open', {
        options: {
          title: translate(
            'auto.web.tauriNative.dialog.selectMarkdownDocument',
            'Select markdown document'
          ),
          defaultPath: directory,
          multiple: false,
          filters: [{ name: 'Markdown', extensions: ['md', 'mdx', 'markdown'] }]
        }
      })
      const filePath = Array.isArray(picked) ? picked[0] : picked
      if (!filePath) {
        return null
      }
      return callRuntimeResult<MarkdownDocument>('host.floating.resolveMarkdownDocument', {
        filePath,
        directory
      })
    },
    pickFloatingWorkspaceDirectory: async () => {
      const picked = await invokePlugin<string | string[] | null>('dialog', 'open', {
        options: {
          title: translate(
            'auto.web.tauriNative.dialog.selectFloatingWorkspaceDirectory',
            'Select floating workspace directory'
          ),
          directory: true,
          multiple: false
        }
      })
      const dirPath = Array.isArray(picked) ? picked[0] : picked
      if (!dirPath) {
        return null
      }
      await callRuntimeResult<void>('host.floating.trustDirectory', { dirPath })
      return dirPath
    },
    // Why native: the evidence lands in the app-owned profile like
    // Electron's userData write, so the web reject fallback only applies
    // off the Tauri host.
    writeTerminalRenderDesyncEvidence: (args: WriteTerminalRenderDesyncEvidenceArgs) =>
      invokeNative<WriteTerminalRenderDesyncEvidenceResult>(
        'poc_write_terminal_render_desync_evidence',
        { args }
      ),
    // Tauri owns a local orcad runtime through the same RPC boundary as a
    // paired desktop. Query its durable inventory so existing Codex/Claude
    // chats are restored even when the new-chat preference is disabled.
    holdsStructuredAgentSessions: holdsTauriStructuredAgentSessions,
    onStructuredAgentSessionsHeldChanged: onTauriStructuredAgentSessionsHeldChanged,
    // `reload` intentionally keeps the Rust process and sidecar alive. The
    // other two operations must replace the native owner, like Electron's
    // app.relaunch()/restart() do.
    reload: () =>
      prepareAndInvokeAppRestart(
        window,
        async () => window.location.reload(),
        awaitBeforeUnloadCheckpoint
      ),
    relaunch: invokeRestart,
    restart: invokeRestart,
    // Why native: the elevation helper + UAC handoff live in the Rust owner
    // like Electron main, so the web desktop-app reject only applies off the
    // Tauri host.
    restartAsAdministrator: () => invokeNative<void>('poc_restart_as_administrator')
  }
}

export function createTauriNativeAppNamespaceApi(): Pick<PreloadApi, 'app'> {
  const api = createTauriNativeAppApi()
  const fallback = createWebAppApi().app
  if (!fallback) {
    throw new Error('The web app API fallback is unavailable.')
  }
  return {
    app: {
      ...fallback,
      getIdentity: api.getIdentity ?? fallback.getIdentity,
      getWindowsAdministratorStatus:
        api.getWindowsAdministratorStatus ?? fallback.getWindowsAdministratorStatus,
      getFeatureWallAssetBaseUrl:
        api.getFeatureWallAssetBaseUrl ?? fallback.getFeatureWallAssetBaseUrl,
      holdsStructuredAgentSessions:
        api.holdsStructuredAgentSessions ?? fallback.holdsStructuredAgentSessions,
      onStructuredAgentSessionsHeldChanged:
        api.onStructuredAgentSessionsHeldChanged ?? fallback.onStructuredAgentSessionsHeldChanged,
      getFloatingTerminalCwd: api.getFloatingTerminalCwd ?? fallback.getFloatingTerminalCwd,
      getFloatingMarkdownDirectory:
        api.getFloatingMarkdownDirectory ?? fallback.getFloatingMarkdownDirectory,
      pickFloatingMarkdownDocument:
        api.pickFloatingMarkdownDocument ?? fallback.pickFloatingMarkdownDocument,
      pickFloatingWorkspaceDirectory:
        api.pickFloatingWorkspaceDirectory ?? fallback.pickFloatingWorkspaceDirectory,
      writeTerminalRenderDesyncEvidence:
        api.writeTerminalRenderDesyncEvidence ?? fallback.writeTerminalRenderDesyncEvidence,
      reload: api.reload ?? fallback.reload,
      relaunch: api.relaunch ?? fallback.relaunch,
      restart: api.restart ?? fallback.restart,
      restartAsAdministrator: api.restartAsAdministrator ?? fallback.restartAsAdministrator
    }
  }
}
