import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { emitBrowserCookieImportToast } from '@/lib/browser/cookies/browser-cookie-import-toast'
import { useAppStore } from '@/store/index'
import { useMountedRef } from '@/hooks/useMountedRef'
import { shouldShowBrowserImportHint } from '../profile-routing/browser-import-hint-visibility'
import type {
  BrowserSessionProfile,
  BrowserViewportPresetId
} from '../../../../../../shared/browser/workspaces/browser-workspace-types'
import type {
  BrowserPageSiteDisplay,
  BrowserSiteColorScheme
} from '../../../../../../shared/browser/site-settings/browser-site-display'
import type { BrowserPageZoomDirection } from '../../../../../../shared/browser/site-settings/browser-page-zoom'
import {
  addBrowserPageSiteDisplayListener,
  publishBrowserPageSiteDisplay
} from '../../host-guest/viewport/browser-page-zoom'
import {
  BrowserToolbarMenuDropdown,
  type BrowserToolbarPageActions
} from './browser-toolbar-menu-dropdown'
import { BrowserToolbarProfileDialogs } from '../profile-routing/browser-toolbar-profile-dialogs'
import { useTranslate } from '@/i18n/use-translate'
import type { BrowserChromeOverflowMenuProps } from './browser-chrome-toolbar'
import type { BrowserPageSiteDisplaySource } from './browser-page-site-display-source'
import { browserCookieImportFailureText } from '@/lib/browser/cookies/browser-cookie-import-error-copy'
import { useBrowserPageCookieImport } from '../profile-routing/use-browser-page-cookie-import'
import { switchServerBrowserPageProfile } from '../profile-routing/server-browser-page-profile-switch'
import { errorMessage } from '../../../../../../shared/errors/error-message'
import { useRuntimeHostStatusSelector } from '@/store/slices/runtime-status/views/use-runtime-status-view'
import {
  BROWSER_CLIENT_PROFILE_SWITCH_RUNTIME_CAPABILITY,
  BROWSER_TAB_PROFILE_SWITCH_RUNTIME_CAPABILITY
} from '../../../../../../shared/browser/runtime/browser-runtime-capabilities'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId
} from '../../../../../../shared/execution-host/execution-host'

const NO_PROFILES: BrowserSessionProfile[] = []

type BrowserToolbarMenuProps = {
  currentProfileId: string | null
  workspaceId: string
  worktreeId: string
  browserPageId: string
  viewportPresetId: BrowserViewportPresetId | null
  /** Null hides Viewport Size where the page's host can't resize it. */
  onApplyViewportPreset: ((nextId: BrowserViewportPresetId | null) => void) | null
  /** Null hides Zoom and Appearance where the page's host can't report its site settings. */
  siteDisplaySource: BrowserPageSiteDisplaySource | null
  isActive: boolean
  extensionDiscoveryTarget?: boolean
  /** A blank tab shows the import hint on its new tab page, so the tour points there instead. */
  isBlankTab: boolean
  pageActions: BrowserToolbarPageActions
  /** The Extensions › submenu, built by the toolbar that owns the pinned buttons. */
  extensionsSub: React.ReactNode
  /** Set on a server's page this desktop hosts: its profiles are that server's and its jar is its own. */
  clientHostEnvironmentId?: string | null
  /** Set on a page a server renders and streams here: Profile switches it on that server; its jar takes no imports from here. */
  streamedPage?: { environmentId: string; remotePageId: string | null } | null
  overflow: BrowserChromeOverflowMenuProps
}

export function BrowserToolbarMenu({
  currentProfileId,
  workspaceId,
  worktreeId,
  browserPageId,
  viewportPresetId,
  onApplyViewportPreset,
  siteDisplaySource,
  isActive,
  extensionDiscoveryTarget = false,
  isBlankTab,
  pageActions,
  extensionsSub,
  clientHostEnvironmentId = null,
  streamedPage = null,
  overflow
}: BrowserToolbarMenuProps): React.JSX.Element {
  const t = useTranslate()
  const { pageRoute, detectedBrowsers, fetchDetectedBrowsers } = useBrowserPageCookieImport(
    worktreeId,
    clientHostEnvironmentId ? { environmentId: clientHostEnvironmentId, browserPageId } : null
  )
  // The page's own host, not the one Settings › Browser shows.
  const profileEnvironmentId = clientHostEnvironmentId ?? streamedPage?.environmentId ?? null
  const profileHostId = profileEnvironmentId
    ? toRuntimeExecutionHostId(profileEnvironmentId)
    : LOCAL_EXECUTION_HOST_ID
  const showsCookieImport = !streamedPage
  const listedProfiles = useAppStore((s) => s.browserSessionProfilesByHostId[profileHostId])
  const browserSessionProfiles = listedProfiles ?? NO_PROFILES
  const fetchBrowserSessionProfiles = useAppStore((s) => s.fetchBrowserSessionProfiles)
  const switchBrowserTabProfile = useAppStore((s) => s.switchBrowserTabProfile)
  const createBrowserSessionProfile = useAppStore((s) => s.createBrowserSessionProfile)
  const importCookiesFromBrowser = useAppStore((s) => s.importCookiesFromBrowser)
  const importCookiesToProfile = useAppStore((s) => s.importCookiesToProfile)
  const browserSessionImportState = useAppStore((s) => s.browserSessionImportState)
  const browserCookieTourStepActive = useAppStore(
    (s) => s.activeContextualTourId === 'browser' && s.activeContextualTourStepIndex === 1
  )
  const browserImportHintHidden = useAppStore((s) => s.browserImportHintHidden)
  const persistedUIReady = useAppStore((s) => s.persistedUIReady)
  // Force the menu open for the tour unless a new tab page is already showing the Import hint.
  const importHintOnPage =
    isBlankTab && shouldShowBrowserImportHint({ persistedUIReady, browserImportHintHidden })
  const shouldForceMenuOpen =
    showsCookieImport && browserCookieTourStepActive && isActive && !importHintOnPage

  const [newProfileDialogOpen, setNewProfileDialogOpen] = useState(false)
  const [newProfileName, setNewProfileName] = useState('')
  const [isCreatingProfile, setIsCreatingProfile] = useState(false)
  const [switchingProfile, setSwitchingProfile] = useState(false)
  const serverSwitchesProfiles = useRuntimeHostStatusSelector(
    profileEnvironmentId,
    (entry) =>
      entry?.status?.capabilities?.includes(
        streamedPage
          ? BROWSER_TAB_PROFILE_SWITCH_RUNTIME_CAPABILITY
          : BROWSER_CLIENT_PROFILE_SWITCH_RUNTIME_CAPABILITY
      ) === true
  )
  const serverPageId = streamedPage ? streamedPage.remotePageId : browserPageId
  const [pendingSwitchProfileId, setPendingSwitchProfileId] = useState<string | null | undefined>(
    undefined
  )
  // The tour's fallback step points at the top Import Cookies row, so it holds the menu open.
  const [menuOpen, setMenuOpen] = useState(shouldForceMenuOpen)
  const [prevShouldForceMenuOpen, setPrevShouldForceMenuOpen] = useState(shouldForceMenuOpen)
  if (prevShouldForceMenuOpen !== shouldForceMenuOpen) {
    setPrevShouldForceMenuOpen(shouldForceMenuOpen)
    setMenuOpen(shouldForceMenuOpen)
  }
  const [siteDisplay, setSiteDisplay] = useState<BrowserPageSiteDisplay | null>(null)
  const mountedRef = useMountedRef()

  const showSiteDisplay = (request: Promise<BrowserPageSiteDisplay | null>): void => {
    void request.then(
      (display) => {
        // Tell the address field's zoom chip too; main has no push event for site display.
        publishBrowserPageSiteDisplay({ browserPageId, display })
        if (mountedRef.current) {
          setSiteDisplay(display)
        }
      },
      // A host that dropped the call leaves the menu showing the last value it reported.
      () => undefined
    )
  }
  const zoomPage = siteDisplaySource
    ? (direction: BrowserPageZoomDirection): void =>
        showSiteDisplay(siteDisplaySource.zoom(direction))
    : null
  const setSiteColorScheme = siteDisplaySource
    ? (colorScheme: BrowserSiteColorScheme | null): void =>
        showSiteDisplay(siteDisplaySource.setColorScheme(colorScheme))
    : null

  useEffect(() => {
    if (!menuOpen) {
      return
    }
    return addBrowserPageSiteDisplayListener(browserPageId, (display) => {
      if (mountedRef.current) {
        setSiteDisplay(display)
      }
    })
  }, [browserPageId, menuOpen, mountedRef])

  const handleMenuOpenChange = (open: boolean): void => {
    if (shouldForceMenuOpen && !open) {
      return
    }
    if (open && siteDisplaySource) {
      // Why on open: the site changes with every navigation and keyboard zoom, so a cached value goes stale.
      showSiteDisplay(siteDisplaySource.read())
    }
    // A failed listing lands as [], since a real one always has Default.
    if (open && !listedProfiles?.length) {
      void fetchBrowserSessionProfiles(profileHostId)
    }
    setMenuOpen(open)
  }

  const handleNewProfileDialogOpenChange = (open: boolean): void => {
    setNewProfileDialogOpen(open)
    if (!open) {
      setNewProfileName('')
    }
  }

  const effectiveProfileId = currentProfileId ?? 'default'

  const defaultProfile = browserSessionProfiles.find((p) => p.id === 'default')
  const allProfiles = defaultProfile
    ? [defaultProfile, ...browserSessionProfiles.filter((p) => p.id !== 'default')]
    : browserSessionProfiles

  const handleSwitchProfile = (profileId: string | null): void => {
    const targetId = profileId ?? 'default'
    if (targetId === effectiveProfileId) {
      return
    }
    setPendingSwitchProfileId(profileId)
  }

  // A server's page is switched by that server; a local page's tab switches here.
  const switchPageProfile = async (
    profileId: string | null,
    partition: string | null
  ): Promise<boolean> => {
    if (!profileEnvironmentId) {
      // Persist the partition with the profile so stale renderer mirrors cannot weaken tab isolation.
      switchBrowserTabProfile(workspaceId, profileId, partition)
      return true
    }
    if (!serverPageId) {
      return false
    }
    setSwitchingProfile(true)
    const switched = await switchServerBrowserPageProfile(
      profileEnvironmentId,
      serverPageId,
      profileId ?? 'default'
    ).then(
      () => true,
      (error: unknown) => {
        toast.error(errorMessage(error))
        return false
      }
    )
    if (mountedRef.current) {
      setSwitchingProfile(false)
    }
    return switched
  }

  const confirmSwitchProfile = async (): Promise<void> => {
    if (pendingSwitchProfileId === undefined) {
      return
    }
    const targetId = pendingSwitchProfileId ?? 'default'
    const profile = browserSessionProfiles.find((p) => p.id === targetId)
    setPendingSwitchProfileId(undefined)
    if (await switchPageProfile(pendingSwitchProfileId, profile?.partition ?? null)) {
      toast.success(
        t(
          'auto.components.browser.pane.BrowserToolbarMenu.3ccd29d771',
          'Switched to {{value0}} profile',
          { value0: profile?.label ?? 'Default' }
        )
      )
    }
  }

  const handleCreateProfile = async (): Promise<void> => {
    const trimmed = newProfileName.trim()
    if (!trimmed) {
      return
    }

    setIsCreatingProfile(true)
    try {
      const profile = await createBrowserSessionProfile('isolated', trimmed, profileHostId)
      if (!profile) {
        if (mountedRef.current) {
          toast.error(
            t(
              'auto.components.browser.pane.BrowserToolbarMenu.4d2f9f13a7',
              'Failed to create profile.'
            )
          )
        }
        return
      }

      if (!mountedRef.current) {
        return
      }

      setNewProfileDialogOpen(false)
      setNewProfileName('')

      if (await switchPageProfile(profile.id, profile.partition)) {
        toast.success(
          t(
            'auto.components.browser.pane.BrowserToolbarMenu.a7a86702b3',
            'Created and switched to {{value0}} profile',
            { value0: profile.label }
          )
        )
      }
    } finally {
      if (mountedRef.current) {
        setIsCreatingProfile(false)
      }
    }
  }

  const handleImportFromBrowser = async (
    browserFamily: string,
    browserProfile?: string
  ): Promise<void> => {
    const result = await importCookiesFromBrowser(
      effectiveProfileId,
      browserFamily,
      browserProfile,
      pageRoute
    )
    if (result.ok) {
      const browser = detectedBrowsers.find((b) => b.family === browserFamily)
      emitBrowserCookieImportToast(
        result.summary,
        browserProfile
          ? t(
              'auto.components.browser.pane.BrowserToolbarMenu.c5f0e4d3b2a1',
              'Imported {{value0}} cookies from {{value1}} ({{value2}}).',
              {
                value0: result.summary.importedCookies,
                value1: browser?.label ?? browserFamily,
                value2: browserProfile
              }
            )
          : t(
              'auto.components.browser.pane.BrowserToolbarMenu.d6a1f5e4c3b2',
              'Imported {{value0}} cookies from {{value1}}.',
              {
                value0: result.summary.importedCookies,
                value1: browser?.label ?? browserFamily
              }
            ),
        result
      )
    } else {
      toast.error(browserCookieImportFailureText(result))
    }
  }

  const handleImportFromFile = async (): Promise<void> => {
    const result = await importCookiesToProfile(effectiveProfileId, pageRoute)
    if (result.ok) {
      emitBrowserCookieImportToast(
        result.summary,
        t(
          'auto.components.browser.pane.BrowserToolbarMenu.53bbe3dab4',
          'Imported {{value0}} cookies from file.',
          { value0: result.summary.importedCookies }
        ),
        result
      )
    } else if (result.reason !== 'canceled') {
      toast.error(browserCookieImportFailureText(result))
    }
  }

  return (
    <>
      <BrowserToolbarMenuDropdown
        extensionDiscoveryTarget={extensionDiscoveryTarget}
        browserPageId={browserPageId}
        menuOpen={menuOpen}
        onMenuOpenChange={handleMenuOpenChange}
        profile={
          !profileEnvironmentId || (serverSwitchesProfiles && serverPageId)
            ? {
                browserPageId,
                allProfiles,
                switching: switchingProfile,
                effectiveProfileId,
                onSwitchProfile: handleSwitchProfile,
                onNewProfile: () => setNewProfileDialogOpen(true)
              }
            : null
        }
        cookieImport={
          showsCookieImport
            ? {
                browserPageId,
                effectiveProfileId,
                detectedBrowsers,
                onFetchDetectedBrowsers: () => void fetchDetectedBrowsers(),
                browserSessionImportState,
                pageRoute,
                onImportFromBrowser: (browserFamily, browserProfile) =>
                  void handleImportFromBrowser(browserFamily, browserProfile),
                onImportFromFile: () => void handleImportFromFile()
              }
            : null
        }
        pageActions={pageActions}
        extensionsSub={extensionsSub}
        viewportPresetId={viewportPresetId}
        onApplyViewportPreset={onApplyViewportPreset}
        siteDisplay={siteDisplay}
        onZoomPage={zoomPage}
        onSetSiteColorScheme={setSiteColorScheme}
        overflow={overflow}
      />

      <BrowserToolbarProfileDialogs
        pendingSwitchProfileId={pendingSwitchProfileId}
        onPendingSwitchChange={() => setPendingSwitchProfileId(undefined)}
        onConfirmSwitch={() => void confirmSwitchProfile()}
        newProfileDialogOpen={newProfileDialogOpen}
        onNewProfileDialogOpenChange={handleNewProfileDialogOpenChange}
        newProfileName={newProfileName}
        onNewProfileNameChange={setNewProfileName}
        isCreatingProfile={isCreatingProfile}
        onCreateProfile={() => void handleCreateProfile()}
        onCancelNewProfile={() => {
          setNewProfileDialogOpen(false)
          setNewProfileName('')
        }}
      />
    </>
  )
}
