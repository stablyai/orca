import type { PreloadApi } from '../../../../preload/api-types'
import { translate } from '@/i18n/i18n'
import { noopUnsubscribe } from './web-storage'

function desktopOnlyExtensionsResult(): { ok: false; error: string } {
  return {
    ok: false,
    error: translate(
      'settings.browser.extensions.desktopOnly',
      'Browser extensions run only in the Orca desktop app.'
    )
  }
}

export function createBrowserApi(): NonNullable<Partial<PreloadApi>['browser']> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a partial stub; withFallback in web-preload-api answers every browser member it omits.
  return {
    registerGuest: () => Promise.resolve(false),
    isGuestRegistered: () => Promise.resolve(false),
    repairGuestRegistration: () => Promise.resolve(false),
    unregisterGuest: () => Promise.resolve(),
    openDevTools: () => Promise.resolve(false),
    setViewportOverride: () => Promise.resolve(false),
    reportViewportScrollState: () => {},
    setAnnotationViewportBridge: () => Promise.resolve(false),
    // A web client never hosts pages, so it has no lease to publish over.
    publishClientPageMetadata: () => Promise.resolve({ status: 'refused' as const }),
    onGuestLoadFailed: () => noopUnsubscribe,
    onCertificateFailureChanged: () => noopUnsubscribe,
    proceedCertificate: () => Promise.resolve({ ok: false, reason: 'missing' }),
    onPermissionDenied: () => noopUnsubscribe,
    onPopup: () => noopUnsubscribe,
    onDownloadRequested: () => noopUnsubscribe,
    onDownloadProgress: () => noopUnsubscribe,
    onDownloadFinished: () => noopUnsubscribe,
    onContextMenuRequested: () => noopUnsubscribe,
    onTargetUrlChanged: () => noopUnsubscribe,
    onContextMenuDismissed: () => noopUnsubscribe,
    onNavigationUpdate: () => noopUnsubscribe,
    onActivateView: () => noopUnsubscribe,
    onPaneFocus: () => noopUnsubscribe,
    onOpenLinkInOrcaTab: () => noopUnsubscribe,
    cancelDownload: () => Promise.resolve(false),
    setGrabMode: () =>
      Promise.resolve({
        ok: false,
        error: translate(
          'auto.web.web.preload.api.31bea294d5',
          'Grab mode is unavailable in the web client.'
        )
      }),
    awaitGrabSelection: () =>
      Promise.resolve({
        ok: false,
        error: translate(
          'auto.web.web.preload.api.31bea294d5',
          'Grab mode is unavailable in the web client.'
        )
      }),
    cancelGrab: () => Promise.resolve(false),
    captureSelectionScreenshot: () =>
      Promise.resolve({
        ok: false,
        error: translate(
          'auto.web.web.preload.api.8dfcb7a351',
          'Selection screenshots are unavailable in the web client.'
        )
      }),
    extractHoverPayload: () =>
      Promise.resolve({
        ok: false,
        error: translate(
          'auto.web.web.preload.api.275a776357',
          'Hover extraction is unavailable in the web client.'
        )
      }),
    onGrabModeToggle: () => noopUnsubscribe,
    onGrabActionShortcut: () => noopUnsubscribe,
    sessionListProfiles: () => Promise.resolve([]),
    onSessionProfilesChanged: () => noopUnsubscribe,
    // Web clients render remote workspaces through the server; no local SSH routing exists.
    prepareSshWorkspacePartition: () =>
      Promise.reject(new Error('browser_local_route_unavailable')),
    sessionCreateProfile: () => Promise.resolve(null),
    sessionDeleteProfile: () => Promise.resolve(false),
    sessionImportCookies: () =>
      Promise.resolve({
        ok: false,
        summary: null,
        error: translate(
          'auto.web.web.preload.api.67ec964791',
          'Cookie import is unavailable in the web client.'
        )
      }),
    sessionResolvePartition: () => Promise.resolve(null),
    sessionDetectBrowsers: () => Promise.resolve([]),
    sessionDetectBrowsersForClientHost: () => Promise.resolve(null),
    sessionImportFromBrowserForClientHost: () => Promise.resolve(null),
    sessionClientRouteImportSources: () => Promise.resolve({}),
    sessionImportFromBrowser: () =>
      Promise.resolve({
        ok: false,
        summary: null,
        error: translate(
          'auto.web.web.preload.api.67ec964791',
          'Cookie import is unavailable in the web client.'
        )
      }),
    sessionGoogleCookieClearTarget: () => Promise.resolve(null),
    sessionClearGoogleCookies: () => Promise.resolve('unverified' as const),
    sessionClearDefaultCookies: () => Promise.resolve(false),
    sitePermissionsList: () => Promise.resolve([]),
    sitePermissionsSet: () => Promise.resolve([]),
    notifyActiveTabChanged: () => Promise.resolve(false),
    extensionsList: () => Promise.resolve({ active: false, extensions: [] }),
    extensionsSetEnabled: () => Promise.resolve(desktopOnlyExtensionsResult()),
    extensionsRemove: () => Promise.resolve(desktopOnlyExtensionsResult()),
    extensionsLoadUnpacked: () => Promise.resolve(desktopOnlyExtensionsResult()),
    extensionsReload: () => Promise.resolve(desktopOnlyExtensionsResult()),
    extensionsOpenOptions: () => Promise.resolve(desktopOnlyExtensionsResult()),
    extensionsReviewUpdate: () => Promise.resolve(desktopOnlyExtensionsResult()),
    onExtensionsChanged: () => noopUnsubscribe,
    extensionsToolbarState: () => Promise.resolve(null),
    extensionsSetPinned: () => Promise.resolve(desktopOnlyExtensionsResult()),
    extensionsActivateAction: () => Promise.resolve(desktopOnlyExtensionsResult()),
    extensionsPageIcon: () => Promise.resolve(null),
    onExtensionsToolbarChanged: () => noopUnsubscribe,
    onExtensionsPopupRequested: () => noopUnsubscribe,
    onRequestTabActivate: () => noopUnsubscribe,
    replyTabActivate: () => {},
    extensionsInstallFromWebStore: () =>
      Promise.resolve({ status: 'failed', error: desktopOnlyExtensionsResult().error }),
    onExtensionInstallPrompt: () => noopUnsubscribe,
    onExtensionInstallPromptClosed: () => noopUnsubscribe,
    respondExtensionInstallPrompt: () => Promise.resolve(false),
    extensionsContextMenuClick: () => Promise.resolve(false),
    extensionsActionContextMenu: () => Promise.resolve(null)
  } as unknown as NonNullable<Partial<PreloadApi>['browser']>
}

export function createEmulatorApi(): NonNullable<Partial<PreloadApi>['emulator']> {
  return {
    onPaneFocus: () => noopUnsubscribe,
    onAutoAttach: () => noopUnsubscribe,
    startFrameStream: () => Promise.reject(new Error('Mobile emulator is unavailable on web.')),
    stopFrameStream: () => Promise.resolve(),
    onFrameStreamFrame: () => noopUnsubscribe,
    onFrameStreamError: () => noopUnsubscribe
  } as unknown as NonNullable<Partial<PreloadApi>['emulator']>
}
