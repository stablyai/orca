import type { PreloadApi } from '../../../preload/api-types'
import { buildBrowserAnnotationViewportBridgeScript } from '../../../shared/browser/annotations/browser-annotation-viewport-bridge'
import type {
  BrowserCertificateProceedResult,
  BrowserViewportOverride
} from '../../../shared/browser/workspaces/browser-workspace-types'
import type {
  BrowserCaptureSelectionScreenshotResult,
  BrowserGrabCancelReason,
  BrowserGrabPayload,
  BrowserGrabResult,
  BrowserExtractHoverResult,
  BrowserSetGrabModeResult
} from '../../../shared/browser/element-grab/browser-grab-types'
import { clampGrabPayload } from '../../../main/browser/element-grab/browser-grab-payload'
import { buildGuestOverlayScript } from '../../../main/browser/element-grab/grab-guest-script'
import {
  HIDE_BROWSER_GRAB_OVERLAY_SCRIPT,
  RESTORE_BROWSER_GRAB_OVERLAY_SCRIPT
} from '../../../main/browser/element-grab/browser-grab-screenshot'
import { invokeNative, listenNative } from './tauri-native-host'
import { createTauriNativeBrowserEventsApi } from './tauri-native-browser-events'
import { createTauriNativeBrowserSessionApi } from './tauri-native-browser-session'
import { tauriBrowserClientPageRendererBus } from './tauri-native-browser-client-page-renderer-bus'
import { publishTauriBrowserClientPageMetadata } from './tauri-native-browser-client-host'
import {
  getTauriNativeBrowserPageInfo,
  hasTauriNativeBrowserPage,
  removeTauriNativeBrowserPage
} from './tauri-native-browser-webview'

type BrowserPageEvent = {
  browserPageId: string
  eventType: string
  url?: string | null
  title?: string | null
}

type UnknownRecord = Record<string, unknown>

function asRecord(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  return Object.fromEntries(Object.entries(value))
}

function normalizeGrabPayload(value: unknown): BrowserGrabPayload | null {
  return clampGrabPayload(value)
}

function isGrabCancelReason(value: unknown): value is BrowserGrabCancelReason {
  return (
    value === 'user' ||
    value === 'tab-inactive' ||
    value === 'navigation' ||
    value === 'evicted' ||
    value === 'timeout'
  )
}

function normalizeGrabResult(value: unknown, opId: string): BrowserGrabResult {
  const record = asRecord(value)
  if (!record || typeof record.kind !== 'string') {
    return { opId, kind: 'error', reason: 'Invalid grab result' }
  }
  if (record.kind === 'cancelled' && isGrabCancelReason(record.reason)) {
    return { opId, kind: 'cancelled', reason: record.reason }
  }
  if (record.kind === 'selected' || record.kind === 'context-selected') {
    const payload = normalizeGrabPayload(record.payload)
    if (payload) {
      return { opId, kind: record.kind, payload }
    }
  }
  return {
    opId,
    kind: 'error',
    reason: typeof record.reason === 'string' ? record.reason : 'Invalid grab result'
  }
}

export function createTauriNativeBrowserApi(): Partial<PreloadApi['browser']> {
  return {
    // The retained registry mounts Tauri child webviews through this bus,
    // mirroring Electron's renderer-request channel without crossing IPC.
    onClientPageRendererRequest: tauriBrowserClientPageRendererBus.subscribe,
    // Client-hosted pages publish url/title over the host lease like Electron's main does.
    publishClientPageMetadata: async ({ environmentId, params }) => {
      try {
        // Lazy so importing the browser API never pulls the session store
        // (which reads localStorage at module scope) into window-less tests.
        const { getClientForEnvironment, resolveEnvironment } =
          await import('./runtime/client/web-runtime-session')
        const environment = resolveEnvironment(environmentId)
        return await publishTauriBrowserClientPageMetadata(
          params,
          getClientForEnvironment(environment)
        )
      } catch {
        return { status: 'refused' as const }
      }
    },
    registerGuest: ({ browserPageId }) => Promise.resolve(hasTauriNativeBrowserPage(browserPageId)),
    isGuestRegistered: ({ browserPageId }) =>
      Promise.resolve(hasTauriNativeBrowserPage(browserPageId)),
    repairGuestRegistration: ({ browserPageId }) =>
      Promise.resolve(hasTauriNativeBrowserPage(browserPageId)),
    unregisterGuest: ({ browserPageId }) => {
      removeTauriNativeBrowserPage(browserPageId)
      return Promise.resolve()
    },
    openDevTools: ({ browserPageId }) =>
      invokeNative<boolean>('poc_browser_open_devtools', { args: { browserPageId } }),
    setViewportOverride: ({
      override,
      browserPageId
    }: {
      browserPageId: string
      override: BrowserViewportOverride | null
    }) =>
      invokeNative<boolean>('poc_browser_set_viewport_override', {
        args: {
          browserPageId,
          override
        }
      }),
    setAnnotationViewportBridge: (args) =>
      invokeNative<boolean>('poc_browser_set_annotation_viewport_bridge', {
        args: {
          ...args,
          script: buildBrowserAnnotationViewportBridgeScript(args)
        }
      }),
    proceedCertificate: (args) =>
      invokeNative<BrowserCertificateProceedResult>('poc_browser_proceed_certificate', { args }),
    ...createTauriNativeBrowserEventsApi(),
    ...createTauriNativeBrowserSessionApi(),
    cancelDownload: ({ downloadId }) =>
      invokeNative<boolean>('poc_browser_cancel_download', { args: { downloadId } }),
    setGrabMode: ({ browserPageId, enabled }) =>
      invokeNative<BrowserSetGrabModeResult>('poc_browser_set_grab_mode', {
        args: {
          browserPageId,
          enabled,
          script: buildGuestOverlayScript(enabled ? 'arm' : 'teardown')
        }
      }),
    awaitGrabSelection: async ({ browserPageId, opId }) =>
      normalizeGrabResult(
        await invokeNative<unknown>('poc_browser_await_grab_selection', {
          args: {
            browserPageId,
            opId,
            script: buildGuestOverlayScript('awaitClick')
          }
        }),
        opId
      ),
    cancelGrab: ({ browserPageId }) =>
      invokeNative<boolean>('poc_browser_cancel_grab', {
        args: {
          browserPageId,
          script: buildGuestOverlayScript('teardown')
        }
      }),
    captureSelectionScreenshot: ({ browserPageId, rect }) =>
      invokeNative<BrowserCaptureSelectionScreenshotResult>(
        'poc_browser_capture_selection_screenshot',
        {
          args: {
            browserPageId,
            rect,
            hideScript: HIDE_BROWSER_GRAB_OVERLAY_SCRIPT,
            restoreScript: RESTORE_BROWSER_GRAB_OVERLAY_SCRIPT
          }
        }
      ),
    extractHoverPayload: async ({ browserPageId }) => {
      const result = await invokeNative<unknown>('poc_browser_extract_hover_payload', {
        args: {
          browserPageId,
          script: buildGuestOverlayScript('extractHover')
        }
      })
      const record = asRecord(result)
      const payload = record?.ok === true ? normalizeGrabPayload(record.payload) : null
      if (payload) {
        return { ok: true, payload } satisfies BrowserExtractHoverResult
      }
      return {
        ok: false,
        reason: typeof record?.reason === 'string' ? record.reason : 'No hovered element'
      } satisfies BrowserExtractHoverResult
    },
    onNavigationUpdate: (callback) =>
      listenNative<BrowserPageEvent>('browser:page-event', (event) => {
        // In-page commits never produce did-navigate, so forward them too: automation-driven SPA clicks otherwise leave the tab url behind.
        if (
          event.eventType === 'did-navigate' ||
          event.eventType === 'did-navigate-in-page' ||
          event.eventType === 'page-title-updated'
        ) {
          // A commit carries no title; reuse the page table (kept current by
          // page-title-updated) so the tab keeps its title instead of flashing New Tab.
          const title =
            event.title ?? getTauriNativeBrowserPageInfo(event.browserPageId)?.title ?? ''
          callback({ browserPageId: event.browserPageId, url: event.url ?? '', title })
        }
      })
  }
}
