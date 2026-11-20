import type { PreloadApi } from '../../../preload/api-types'
import type {
  BrowserContextMenuDismissedEvent,
  BrowserContextMenuRequestedEvent
} from '../../../shared/browser/guest-lifecycle/browser-guest-events'
import { listenNative } from './tauri-native-host'

export type TauriBrowserPageEvent = {
  browserPageId: string
  eventType: string
  url?: string | null
  title?: string | null
  errorCode?: number | null
  errorDescription?: string | null
  validatedUrl?: string | null
  isMainFrame?: boolean | null
  isInPlace?: boolean | null
  permission?: string | null
  action?: 'opened-in-orca' | 'opened-external' | 'blocked' | null
  favicons?: string[] | null
  reason?: string | null
  exitCode?: number | null
}

type BrowserDownloadRequestedEvent = Parameters<
  NonNullable<PreloadApi['browser']['onDownloadRequested']>
>[0] extends (event: infer Event) => void
  ? Event
  : never

type BrowserDownloadFinishedEvent = Parameters<
  NonNullable<PreloadApi['browser']['onDownloadFinished']>
>[0] extends (event: infer Event) => void
  ? Event
  : never

type BrowserDownloadProgressEvent = Parameters<
  NonNullable<PreloadApi['browser']['onDownloadProgress']>
>[0] extends (event: infer Event) => void
  ? Event
  : never

type BrowserCertificateFailureEvent = Parameters<
  Parameters<NonNullable<PreloadApi['browser']['onCertificateFailureChanged']>>[0]
>[0]

export function createTauriNativeBrowserEventsApi(): Partial<PreloadApi['browser']> {
  return {
    onGuestLoadFailed: (callback) =>
      listenNative<TauriBrowserPageEvent>('browser:page-event', (event) => {
        if (event.eventType === 'did-fail-load') {
          callback({
            browserPageId: event.browserPageId,
            loadError: {
              code: event.errorCode ?? -1,
              description: event.errorDescription ?? 'Browser page failed to load.',
              validatedUrl: event.validatedUrl ?? event.url ?? ''
            }
          })
        }
      }),
    onCertificateFailureChanged: (callback) =>
      listenNative<BrowserCertificateFailureEvent>('browser:certificate-failure-changed', callback),
    onPermissionDenied: (callback) =>
      listenNative<TauriBrowserPageEvent>('browser:page-event', (event) => {
        if (event.eventType === 'permission-denied' && event.permission) {
          callback({
            browserPageId: event.browserPageId,
            permission: event.permission,
            origin: event.url ?? 'unknown'
          })
        }
      }),
    onPopup: (callback) =>
      listenNative<TauriBrowserPageEvent>('browser:page-event', (event) => {
        if (event.eventType === 'popup' && event.action) {
          callback({
            browserPageId: event.browserPageId,
            origin: event.url ?? 'unknown',
            action: event.action
          })
        }
      }),
    onContextMenuRequested: (callback) =>
      listenNative<BrowserContextMenuRequestedEvent>('browser:context-menu-requested', callback),
    onContextMenuDismissed: (callback) =>
      listenNative<BrowserContextMenuDismissedEvent>('browser:context-menu-dismissed', callback),
    onDownloadRequested: (callback) =>
      listenNative<BrowserDownloadRequestedEvent>('browser:download-requested', callback),
    onDownloadFinished: (callback) =>
      listenNative<BrowserDownloadFinishedEvent>('browser:download-finished', callback),
    onDownloadProgress: (callback) =>
      listenNative<BrowserDownloadProgressEvent>('browser:download-progress', callback)
  }
}
