import type { PreloadApi } from '../../../preload/api-types'
import type {
  NotificationDismissResult,
  NotificationDispatchResult,
  NotificationPermissionStatusResult,
  NotificationSoundResult
} from '../../../shared/notifications/notification-settings-types'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import { parsePaneKey } from '../../../shared/workspace-layout/stable-pane-id'
import { getBrowserPlatform } from './preload-api/web-storage'
import { emitTauriNativeUiEvent } from './tauri-native-ui-api'
import { setTauriTrayAttention } from './tauri-native-tray-api'
import { invokeNative, invokePlugin, isTauriNativeHost } from './tauri-native-host'

type TauriNotificationAction = {
  actionId?: unknown
  notification?: {
    id?: unknown
    extra?: unknown
  } | null
}

const tauriNotificationIds = new Map<string, number>()
const tauriNotificationTargets = new Map<
  string,
  Parameters<PreloadApi['notifications']['dispatch']>[0]
>()
let notificationActionListenerStarted = false

/**
 * The Tauri notification plugin replaces the Web Notification constructor with
 * its native desktop implementation during WebView initialization. Keeping the
 * renderer-facing adapter here preserves Electron's result vocabulary and fallback behavior.
 */
export function createTauriNativeNotificationsApi(): PreloadApi['notifications'] | undefined {
  if (!isTauriNativeHost()) {
    return undefined
  }
  const isSupported = typeof Notification !== 'undefined'
  installNotificationActionListener()
  return {
    getDesktopAwayState: async () => {
      const { away } = await invokeNative<{ away: boolean | null }>('poc_desktop_away_state').catch(
        () => ({ away: null })
      )
      return away ?? undefined
    },
    acknowledgeAttention: async () => ({ dismissed: 0 }),
    dispatch: async (args): Promise<NotificationDispatchResult> => {
      if (!isSupported) {
        return { delivered: false, reason: 'not-supported' }
      }
      const title = args.repoLabel ?? args.worktreeLabel ?? 'Orca'
      const body = buildNotificationBody(args)
      try {
        if (Notification.permission === 'default') {
          await Notification.requestPermission()
        }
        if (Notification.permission !== 'granted') {
          return { delivered: false, reason: 'blocked-by-system' }
        }
        const previousNumericId = args.notificationId
          ? tauriNotificationIds.get(args.notificationId)
          : undefined
        if (previousNumericId !== undefined) {
          await invokePlugin('notification', 'remove_active', {
            notifications: [{ id: previousNumericId }]
          }).catch(() => {})
        }
        const numericId = args.notificationId
          ? notificationIdToNumber(args.notificationId)
          : undefined
        if (args.notificationId && numericId !== undefined) {
          tauriNotificationIds.set(args.notificationId, numericId)
          tauriNotificationTargets.set(args.notificationId, args)
        }
        await invokePlugin('notification', 'notify', {
          options: {
            ...(numericId === undefined ? {} : { id: numericId }),
            title,
            body,
            ...(args.notificationId ? { extra: { orcaNotificationId: args.notificationId } } : {})
          }
        })
        // A bell the user cannot see yet keeps the tray dot until focus returns.
        if (typeof document !== 'undefined' && document.hidden) {
          setTauriTrayAttention(true)
        }
        return { delivered: true }
      } catch {
        if (args.notificationId) {
          tauriNotificationIds.delete(args.notificationId)
          tauriNotificationTargets.delete(args.notificationId)
        }
        return { delivered: false, reason: 'not-displayed' }
      }
    },
    dismiss: async (ids) => dismissTauriNotifications(ids),
    settleStructuredPrompts: async () => {},
    openSystemSettings: async () => {
      await invokePlugin('opener', 'open_url', {
        url: 'ms-settings:notifications',
        with: null
      }).catch(() => {})
    },
    getPermissionStatus: async (): Promise<NotificationPermissionStatusResult> => ({
      supported: isSupported,
      platform: getBrowserPlatform(),
      requested: isSupported && Notification.permission !== 'default'
    }),
    probeDelivery: async () => ({
      state: isSupported
        ? Notification.permission === 'granted'
          ? 'delivered'
          : Notification.permission === 'denied'
            ? 'blocked'
            : 'awaiting-decision'
        : 'unsupported',
      authoritative: false
    }),
    playSound: async (options): Promise<NotificationSoundResult> => {
      const configuredPath = readConfiguredNotificationSoundPath()
      if (!configuredPath) {
        return { played: false, reason: 'missing-path' }
      }
      // Why never throw: Electron playSound resolves playback-failed on any
      // failure, and callers fire-and-forget, so a rejection would go unhandled.
      let resolved: {
        ok: boolean
        path: string | null
        reason?: NotificationSoundResult['reason']
      }
      try {
        resolved = await invokeNative('poc_notification_sound_path', {
          args: { path: configuredPath }
        })
      } catch {
        return { played: false, reason: 'playback-failed' }
      }
      if (!resolved.ok || !resolved.path) {
        return { played: false, reason: resolved.reason ?? 'read-failed' }
      }
      try {
        const audio = new Audio(pathToFileUrl(resolved.path))
        if (typeof options?.volume === 'number' && Number.isFinite(options.volume)) {
          audio.volume = Math.min(1, Math.max(0, options.volume / 100))
        }
        await audio.play()
        return { played: true }
      } catch {
        return { played: false, reason: 'playback-failed' }
      }
    }
  }
}

function installNotificationActionListener(): void {
  if (notificationActionListenerStarted || typeof window === 'undefined') {
    return
  }
  const onAction = window.__TAURI__?.notification?.onAction
  if (!onAction) {
    return
  }
  notificationActionListenerStarted = true
  void onAction<TauriNotificationAction>((action) => {
    if (action.actionId !== 'tap') {
      return
    }
    const extra = action.notification?.extra
    if (typeof extra !== 'object' || extra === null || !('orcaNotificationId' in extra)) {
      return
    }
    const notificationId = extra.orcaNotificationId
    if (typeof notificationId !== 'string') {
      return
    }
    const target = tauriNotificationTargets.get(notificationId)
    if (!target) {
      return
    }
    tauriNotificationTargets.delete(notificationId)
    void routeNotificationTarget(target)
  }).catch(() => {
    notificationActionListenerStarted = false
  })
}

async function routeNotificationTarget(
  target: Parameters<PreloadApi['notifications']['dispatch']>[0]
): Promise<void> {
  await invokeNative('poc_reveal_window').catch(() => {})
  const worktreeId = target.worktreeId
  if (!worktreeId) {
    return
  }
  const paneTarget = target.paneKey ? parsePaneKey(target.paneKey) : null
  const repoId = worktreeId.includes('::') ? getRepoIdFromWorktreeId(worktreeId) : null
  if (repoId !== null) {
    emitTauriNativeUiEvent('activateWorktree', { repoId, worktreeId })
  }
  if (target.surface === 'agent-session' && paneTarget) {
    emitTauriNativeUiEvent('focusEditorTab', {
      tabId: paneTarget.tabId,
      worktreeId,
      userInitiated: true
    })
    return
  }
  if (paneTarget) {
    emitTauriNativeUiEvent('focusTerminal', {
      tabId: paneTarget.tabId,
      worktreeId,
      leafId: paneTarget.leafId,
      ackPaneKeyOnSuccess: target.paneKey,
      flashFocusedPane: true,
      scrollToBottomIfOutputSinceLastView: true
    })
  }
}

async function dismissTauriNotifications(ids: string[]): Promise<NotificationDismissResult> {
  const numericIds = ids.flatMap((id) => {
    const numericId = tauriNotificationIds.get(id)
    if (numericId === undefined) {
      return []
    }
    tauriNotificationIds.delete(id)
    tauriNotificationTargets.delete(id)
    return [{ id: numericId }]
  })
  if (numericIds.length === 0) {
    return { dismissed: 0 }
  }
  try {
    await invokePlugin('notification', 'remove_active', { notifications: numericIds })
    return { dismissed: numericIds.length }
  } catch {
    return { dismissed: 0 }
  }
}

function notificationIdToNumber(notificationId: string): number {
  const existing = tauriNotificationIds.get(notificationId)
  if (existing !== undefined) {
    return existing
  }
  let hash = 2166136261
  for (const character of notificationId) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0) % 2147483647 || 1
}

function buildNotificationBody(
  args: Parameters<PreloadApi['notifications']['dispatch']>[0]
): string {
  if (args.surface === 'agent-session') {
    return args.agentLastAssistantMessage ?? args.agentPrompt ?? ''
  }
  return args.terminalTitle ?? ''
}

function pathToFileUrl(path: string): string {
  const normalized = path.replaceAll('\\', '/')
  const prefixed = normalized.startsWith('/') ? normalized : `/${normalized}`
  return `file://${encodeURI(prefixed)}`
}

function readConfiguredNotificationSoundPath(): string | null {
  try {
    const raw = window.localStorage.getItem('orca-settings')
    if (!raw) {
      return null
    }
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) {
      return null
    }
    if (!('notifications' in parsed) || typeof parsed.notifications !== 'object') {
      return null
    }
    const notifications = parsed.notifications
    if (notifications === null || !('customSoundPath' in notifications)) {
      return null
    }
    const path = notifications.customSoundPath
    return typeof path === 'string' && path.trim() ? path : null
  } catch {
    return null
  }
}
