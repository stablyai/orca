import type { AgentSessionAttachmentClipboardTarget } from '../../../shared/agent-session/agent-session-attachments'
import type { PreloadApi } from '../../../preload/api-types'
import type { BrowserPageZoomCommand } from '../../../shared/browser/site-settings/browser-page-zoom'
import {
  assertClipboardTextWithinLimitWithYield,
  assertClipboardTextWriteWithinLimitWithYield,
  type ReadClipboardTextOptions
} from '../../../shared/clipboard/clipboard-text'
import { uiZoomFactorFromLevel } from '../../../shared/app-lifecycle/windows/ui-zoom-level'
import { invokeNative, invokePlugin, isTauriNativeHost, listenNative } from './tauri-native-host'
import { createTauriNativeSecondInstanceBridge } from './tauri-native-second-instance'
import {
  readTauriClipboardImagePngBase64,
  readTauriClipboardImageThumbnail,
  tauriClipboardHasImage,
  writeTauriClipboardImage
} from './tauri-native-clipboard'
import { saveClipboardImageAsWebAgentSessionAttachment } from './preload-api/agents/web-agent-session-attachment-upload'
import { saveClipboardImageAsTempFileInRuntime } from './preload-api/clipboard/web-clipboard-api'
import { requireActiveEnvironmentOrNull } from './runtime/client/web-runtime-session'

const EVENT_MAXIMIZE_CHANGED = 'window:maximize-changed'
const EVENT_FULLSCREEN_CHANGED = 'window:fullscreen-changed'
const EVENT_WINDOW_CLOSE_REQUESTED = 'window:close-requested'
const EVENT_TERMINAL_ZOOM = 'terminal:zoom'
const EVENT_OPEN_SETTINGS = 'orca:tauri-ui:openSettings'
const EVENT_APP_MENU_PASTE = 'orca:tauri-ui:appMenuPaste'
const EVENT_APP_MENU_SELECTION = 'orca:tauri-ui:appMenuSelectionAction'
const EVENT_APP_MENU_EDIT_ACTION = 'orca:tauri-ui:appMenuEditAction'
const EVENT_TOGGLE_LEFT_SIDEBAR = 'orca:tauri-ui:toggleLeftSidebar'
const EVENT_TOGGLE_RIGHT_SIDEBAR = 'orca:tauri-ui:toggleRightSidebar'
const EVENT_TOGGLE_WORKTREE_PALETTE = 'orca:tauri-ui:toggleWorktreePalette'
const EVENT_TOGGLE_STATUS_BAR = 'orca:tauri-ui:toggleStatusBar'
const EVENT_OPEN_SETUP_GUIDE = 'orca:tauri-ui:openSetupGuide'
const EVENT_OPEN_FEATURE_TOUR = 'orca:tauri-ui:openFeatureTour'
const EVENT_OPEN_CRASH_REPORT = 'orca:tauri-ui:openCrashReport'
const EVENT_TOGGLE_APPEARANCE = 'orca:tauri-ui:toggleAppearance'
// Why: WebView2 has no before-mouse-event hook, so the guest init script
// posts a Ctrl/Meta+wheel zoom intent that Rust re-emits under this name and
// the browser pane consumes through `onZoomBrowserPage` like Electron's IPC.
const EVENT_BROWSER_GUEST_WHEEL_ZOOM = 'browser:guest-wheel-zoom'
const EVENT_UI_PREFIX = 'orca:tauri-ui:'

type UiEventPayload<Method extends keyof PreloadApi['ui']> = PreloadApi['ui'][Method] extends (
  callback: (payload: infer Payload) => unknown
) => unknown
  ? Payload
  : never

type TauriNativeUiEventPayloads = {
  activateWorktree: UiEventPayload<'onActivateWorktree'>
  focusTerminal: UiEventPayload<'onFocusTerminal'>
  focusEditorTab: UiEventPayload<'onFocusEditorTab'>
}

export type TauriNativeUiEvent = keyof TauriNativeUiEventPayloads

export function emitTauriNativeUiEvent<Event extends TauriNativeUiEvent>(
  event: Event,
  payload: TauriNativeUiEventPayloads[Event]
): void {
  window.dispatchEvent(new CustomEvent(`${EVENT_UI_PREFIX}${event}`, { detail: payload }))
}

function listenTauriNativeUiEvent<EventName extends TauriNativeUiEvent>(
  event: EventName,
  callback: (payload: TauriNativeUiEventPayloads[EventName]) => void
): () => void {
  const eventName = `${EVENT_UI_PREFIX}${event}`
  const listener = (message: globalThis.Event): void => {
    if (message instanceof CustomEvent) {
      callback(message.detail)
    }
  }
  window.addEventListener(eventName, listener)
  return () => window.removeEventListener(eventName, listener)
}

export function createTauriNativeUiApi(): Partial<PreloadApi['ui']> {
  if (!isTauriNativeHost()) {
    return {}
  }
  let zoomLevel = 0
  const secondInstance = createTauriNativeSecondInstanceBridge()
  const saveClipboardImageAsTempFile = async (args?: {
    connectionId?: string | null
    runtimeEnvironmentId?: string | null
    agentSessionAttachment?: AgentSessionAttachmentClipboardTarget
  }): Promise<string | null> => {
    const contentBase64 = await readTauriClipboardImagePngBase64()
    if (!contentBase64) {
      return null
    }
    const environment = requireActiveEnvironmentOrNull()
    if (!environment) {
      return null
    }
    if (args?.agentSessionAttachment) {
      return saveClipboardImageAsWebAgentSessionAttachment(contentBase64, {
        ...args.agentSessionAttachment,
        environmentId: args.runtimeEnvironmentId ?? environment.id
      })
    }
    return saveClipboardImageAsTempFileInRuntime(contentBase64, {
      connectionId: args?.connectionId,
      runtimeEnvironmentId: args?.runtimeEnvironmentId ?? environment.id
    })
  }
  return {
    readClipboardText: async (options?: ReadClipboardTextOptions) =>
      assertClipboardTextWithinLimitWithYield(
        await invokePlugin<string>('clipboard-manager', 'read_text'),
        options
      ),
    writeClipboardText: async (text) => {
      await assertClipboardTextWriteWithinLimitWithYield(text)
      await invokePlugin('clipboard-manager', 'write_text', { text, label: null })
    },
    writeTerminalClipboardText: async (text) => {
      await assertClipboardTextWriteWithinLimitWithYield(text)
      await invokePlugin('clipboard-manager', 'write_text', { text, label: null })
    },
    readSelectionClipboardText: async (options) =>
      assertClipboardTextWithinLimitWithYield(
        await invokePlugin<string>('clipboard-manager', 'read_text'),
        options
      ),
    saveClipboardImageAsTempFile,
    clipboardHasImage: tauriClipboardHasImage,
    readClipboardImageThumbnail: readTauriClipboardImageThumbnail,
    writeClipboardImage: writeTauriClipboardImage,
    writeSelectionClipboardText: async (text) => {
      await assertClipboardTextWriteWithinLimitWithYield(text)
      await invokePlugin('clipboard-manager', 'write_text', { text, label: null })
    },
    readClipboardFilePaths: () => invokeNative<string[]>('poc_clipboard_read_file_paths'),
    // Why real: a restored native-chat draft asks the host which paste files
    // survived, so the composer's draft can re-attach them or show a
    // placeholder. Rust mirrors Electron's realpath-containment check against
    // the same ORCA_USER_DATA/native-chat-pastes folder the runtime wrote to.
    restoreNativeChatPastes: (paths) =>
      invokeNative<{ path: string; kept: boolean; exists: boolean }[]>(
        'poc_clipboard_restore_native_chat_pastes',
        { paths }
      ),
    writeClipboardFile: (value) => {
      const args = typeof value === 'string' ? { filePath: value } : value
      if (args.connectionId) {
        return Promise.resolve({ ok: false, reason: 'remote-not-supported' })
      }
      return invokeNative<{ ok: boolean; reason?: string }>('poc_clipboard_write_file', {
        args: { ...args, connectionId: null }
      })
    },
    // Why DOM-level: the app-menu paste path already resolves Orca-owned
    // targets before falling back here, so this last resort only needs the
    // focused editable to accept a paste — the same execCommand surface the
    // web client and Electron's `webContents.paste()` both end on. WebView2 has
    // no pasteAndMatchStyle equivalent, so both modes land on plain paste.
    performNativePaste: () => {
      document.execCommand?.('paste')
    },
    performNativeSelectionAction: (action) => {
      document.execCommand?.(action === 'copy' ? 'copy' : 'selectAll')
    },
    // Why stubs: Electron's before-input-event reads these focus mirrors to
    // route shortcuts before the renderer sees them; Tauri resolves shortcuts
    // in the renderer keydown path where the DOM already knows focus. The
    // rich-markdown context-menu pair feeds Electron's native context-menu
    // handler, which WebView2 cannot intercept — a known parity gap.
    syncTrafficLights: () => {},
    setMarkdownEditorFocused: () => {},
    setRichMarkdownContextMenuTarget: () => {},
    setTerminalInputFocused: () => {},
    setFloatingFocus: () => {},
    setShortcutRecorderFocused: () => {},
    onRichMarkdownContextCommand: () => () => {},
    isMaximized: () => invokeNative<boolean>('poc_is_maximized'),
    minimize: () => {
      void invokeNative('poc_minimize').catch(() => {})
    },
    maximize: () => {
      void invokeNative('poc_toggle_maximize').catch(() => {})
    },
    onMaximizeChanged: (callback) => listenNative<boolean>(EVENT_MAXIMIZE_CHANGED, callback),
    onFullscreenChanged: (callback) => listenNative<boolean>(EVENT_FULLSCREEN_CHANGED, callback),
    onOpenSkillShare: secondInstance.onOpenSkillShare,
    onOpenSettings: (callback) => listenNative(EVENT_OPEN_SETTINGS, callback),
    onAppMenuPaste: (callback) => listenNative(EVENT_APP_MENU_PASTE, callback),
    onAppMenuSelectionAction: (callback) =>
      listenNative<'copy' | 'select-all'>(EVENT_APP_MENU_SELECTION, callback),
    performNativeEditAction: (action) => {
      // Why DOM-level: native editables own their undo stacks; surfaces
      // without one (terminal) ignore it, matching Electron's roles.
      document.execCommand?.(action)
    },
    onAppMenuEditAction: (callback) =>
      listenNative<'undo' | 'redo'>(EVENT_APP_MENU_EDIT_ACTION, callback),
    onToggleLeftSidebar: (callback) => listenNative(EVENT_TOGGLE_LEFT_SIDEBAR, callback),
    onToggleRightSidebar: (callback) => listenNative(EVENT_TOGGLE_RIGHT_SIDEBAR, callback),
    onToggleWorktreePalette: (callback) => listenNative(EVENT_TOGGLE_WORKTREE_PALETTE, callback),
    onToggleStatusBar: (callback) => listenNative(EVENT_TOGGLE_STATUS_BAR, callback),
    onOpenSetupGuide: (callback) => listenNative(EVENT_OPEN_SETUP_GUIDE, callback),
    onOpenFeatureTour: (callback) => listenNative(EVENT_OPEN_FEATURE_TOUR, callback),
    onOpenCrashReport: (callback) => listenNative(EVENT_OPEN_CRASH_REPORT, callback),
    onToggleAppearance: (callback) =>
      listenNative<
        'showTasksButton' | 'showAutomationsButton' | 'showMobileButton' | 'showTitlebarAppName'
      >(EVENT_TOGGLE_APPEARANCE, callback),
    consumePendingOpenSettings: () => invokeNative<boolean>('poc_consume_pending_open_settings'),
    consumePendingSkillShare: secondInstance.consumePendingSkillShare,
    onOpenMarkdownFiles: secondInstance.onOpenMarkdownFiles,
    consumePendingMarkdownFileOpens: secondInstance.consumePendingMarkdownFileOpens,
    onWindowCloseRequested: (callback) =>
      listenNative<{ isQuitting: boolean; requestId?: number }>(
        EVENT_WINDOW_CLOSE_REQUESTED,
        (payload) => callback({ isQuitting: payload.isQuitting })
      ),
    requestClose: () => {
      void invokeNative('poc_request_close').catch(() => {})
    },
    confirmWindowClose: () => {
      void invokeNative('poc_confirm_close').catch(() => {})
    },
    onTerminalZoom: (callback) =>
      listenNative<'in' | 'out' | 'reset'>(EVENT_TERMINAL_ZOOM, callback),
    onZoomBrowserPage: (callback) =>
      listenNative<BrowserPageZoomCommand>(EVENT_BROWSER_GUEST_WHEEL_ZOOM, callback),
    onActivateWorktree: (callback) => listenTauriNativeUiEvent('activateWorktree', callback),
    onFocusTerminal: (callback) => listenTauriNativeUiEvent('focusTerminal', callback),
    onFocusEditorTab: (callback) => listenTauriNativeUiEvent('focusEditorTab', callback),
    getZoomLevel: () => zoomLevel,
    setZoomLevel: (level) => {
      zoomLevel = level
      void invokeNative('poc_set_zoom', {
        scaleFactor: uiZoomFactorFromLevel(level),
        zoomLevel: level
      }).catch(() => {})
    },
    popupMenu: () => {
      void invokeNative('poc_popup_menu').catch(() => {})
    },
    notifyWindowRevealed: () => {
      void invokeNative('poc_set_focus').catch(() => {})
    }
  }
}
