import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { emitBrowserCookieImportToast } from '@/lib/browser/cookies/browser-cookie-import-toast'
import { useAppStore } from '@/store'
import { useMountedRef } from '@/hooks/useMountedRef'
import { shouldShowBrowserImportHint } from './browser-import-hint-visibility'
import type { BrowserViewportPresetId } from '../../../../../shared/browser-workspace-types'
import type {
  BrowserPageSiteDisplay,
  BrowserSiteColorScheme
} from '../../../../../shared/browser-site-display'
import type { BrowserPageZoomDirection } from '../../../../../shared/browser-page-zoom'
import {
  addBrowserPageSiteDisplayListener,
  publishBrowserPageSiteDisplay
} from '../host-guest/browser-page-zoom'
import {
  BrowserToolbarMenuDropdown,
  type BrowserToolbarPageActions
} from './browser-toolbar-menu-dropdown'
import { BrowserToolbarProfileDialogs } from './browser-toolbar-profile-dialogs'
import { useTranslate } from '@/i18n/use-translate'
import type { BrowserChromeOverflowMenuProps } from './browser-chrome-toolbar'
import { browserCookieImportFailureText } from '@/lib/browser/cookies/browser-cookie-import-error-copy'
import { applyBrowserViewportPreset } from './browser-viewport-preset-apply'

type BrowserToolbarMenuProps = {
  currentProfileId: string | null
  workspaceId: string
  browserPageId: string
  viewportPresetId: BrowserViewportPresetId | null
  onDestroyWebview: () => void
  isActive: boolean
  extensionDiscoveryTarget?: boolean
  /** A blank tab shows the import hint on its new tab page, so the tour points there instead. */
  isBlankTab: boolean
  pageActions: BrowserToolbarPageActions
  /** The Extensions › submenu, built by the toolbar that owns the pinned buttons. */
  extensionsSub: React.ReactNode
  /** Set where switching profiles cannot rebuild this surface's page; the Profile entry renders disabled with this reason. */
  profileUnavailableReason?: string
  overflow: BrowserChromeOverflowMenuProps
}

export function BrowserToolbarMenu({
  currentProfileId,
  workspaceId,
  browserPageId,
  viewportPresetId,
  onDestroyWebview,
  isActive,
  extensionDiscoveryTarget = false,
  isBlankTab,
  pageActions,
  extensionsSub,
  profileUnavailableReason,
  overflow
}: BrowserToolbarMenuProps): React.JSX.Element {
  const t = useTranslate()
  const browserSessionProfiles = useAppStore((s) => s.browserSessionProfiles)
  const detectedBrowsers = useAppStore((s) => s.detectedBrowsers)
  const switchBrowserTabProfile = useAppStore((s) => s.switchBrowserTabProfile)
  const createBrowserSessionProfile = useAppStore((s) => s.createBrowserSessionProfile)
  const importCookiesFromBrowser = useAppStore((s) => s.importCookiesFromBrowser)
  const importCookiesToProfile = useAppStore((s) => s.importCookiesToProfile)
  const fetchDetectedBrowsers = useAppStore((s) => s.fetchDetectedBrowsers)
  const browserSessionImportState = useAppStore((s) => s.browserSessionImportState)
  const browserCookieTourStepActive = useAppStore(
    (s) => s.activeContextualTourId === 'browser' && s.activeContextualTourStepIndex === 1
  )
  const browserImportHintHidden = useAppStore((s) => s.browserImportHintHidden)
  const persistedUIReady = useAppStore((s) => s.persistedUIReady)
  // Force the menu open for the tour unless a new tab page is already showing the Import hint.
  const importHintOnPage =
    isBlankTab && shouldShowBrowserImportHint({ persistedUIReady, browserImportHintHidden })
  const shouldForceMenuOpen = browserCookieTourStepActive && isActive && !importHintOnPage

  const [newProfileDialogOpen, setNewProfileDialogOpen] = useState(false)
  const [newProfileName, setNewProfileName] = useState('')
  const [isCreatingProfile, setIsCreatingProfile] = useState(false)
  const [pendingSwitchProfileId, setPendingSwitchProfileId] = useState<string | null | undefined>(
    undefined
  )
  // Only expose the hidden Import Cookies row when the tour reaches its fallback step.
  const [menuOpen, setMenuOpen] = useState(shouldForceMenuOpen)
  const [prevShouldForceMenuOpen, setPrevShouldForceMenuOpen] = useState(shouldForceMenuOpen)
  if (prevShouldForceMenuOpen !== shouldForceMenuOpen) {
    setPrevShouldForceMenuOpen(shouldForceMenuOpen)
    setMenuOpen(shouldForceMenuOpen)
  }
  const [siteDisplay, setSiteDisplay] = useState<BrowserPageSiteDisplay | null>(null)
  const mountedRef = useMountedRef()

  const showSiteDisplay = (request: Promise<BrowserPageSiteDisplay | null>): void => {
    void request.then((display) => {
      // Tell the address field's zoom chip too; main has no push event for site display.
      publishBrowserPageSiteDisplay({ browserPageId, display })
      if (mountedRef.current) {
        setSiteDisplay(display)
      }
    })
  }
  const zoomPage = (direction: BrowserPageZoomDirection): void =>
    showSiteDisplay(window.api.browser.zoomPage({ browserPageId, direction }))
  const setSiteColorScheme = (colorScheme: BrowserSiteColorScheme | null): void =>
    showSiteDisplay(window.api.browser.setPageSiteColorScheme({ browserPageId, colorScheme }))

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
    if (open) {
      // Why on open: the site changes with every navigation and keyboard zoom, so a cached value goes stale.
      showSiteDisplay(window.api.browser.getPageSiteDisplay({ browserPageId }))
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

  const confirmSwitchProfile = (): void => {
    if (pendingSwitchProfileId === undefined) {
      return
    }
    const targetId = pendingSwitchProfileId ?? 'default'
    const profile = browserSessionProfiles.find((p) => p.id === targetId)
    // Destroy before updating the store; otherwise the stable registry key would reclaim the old partition.
    onDestroyWebview()
    // Persist the partition with the profile so stale renderer mirrors cannot weaken tab isolation.
    switchBrowserTabProfile(workspaceId, pendingSwitchProfileId, profile?.partition ?? null)
    toast.success(
      t(
        'auto.components.browser.pane.BrowserToolbarMenu.3ccd29d771',
        'Switched to {{value0}} profile',
        { value0: profile?.label ?? 'Default' }
      )
    )
    setPendingSwitchProfileId(undefined)
  }

  const handleCreateProfile = async (): Promise<void> => {
    const trimmed = newProfileName.trim()
    if (!trimmed) {
      return
    }

    setIsCreatingProfile(true)
    try {
      const profile = await createBrowserSessionProfile('isolated', trimmed)
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

      onDestroyWebview()
      switchBrowserTabProfile(workspaceId, profile.id, profile.partition)
      toast.success(
        t(
          'auto.components.browser.pane.BrowserToolbarMenu.a7a86702b3',
          'Created and switched to {{value0}} profile',
          { value0: profile.label }
        )
      )
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
    const result = await importCookiesFromBrowser(effectiveProfileId, browserFamily, browserProfile)
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
    const result = await importCookiesToProfile(effectiveProfileId)
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
          profileUnavailableReason
            ? { unavailableReason: profileUnavailableReason }
            : {
                browserPageId,
                allProfiles,
                effectiveProfileId,
                onSwitchProfile: handleSwitchProfile,
                onNewProfile: () => setNewProfileDialogOpen(true),
                detectedBrowsers,
                onFetchDetectedBrowsers: () => void fetchDetectedBrowsers(),
                browserSessionImportState,
                onImportFromBrowser: (browserFamily, browserProfile) =>
                  void handleImportFromBrowser(browserFamily, browserProfile),
                onImportFromFile: () => void handleImportFromFile(),
                forceOpen: shouldForceMenuOpen
              }
        }
        pageActions={pageActions}
        extensionsSub={extensionsSub}
        viewportPresetId={viewportPresetId}
        onApplyViewportPreset={(nextId) => applyBrowserViewportPreset(browserPageId, nextId)}
        siteDisplay={siteDisplay}
        onZoomPage={zoomPage}
        onSetSiteColorScheme={setSiteColorScheme}
        overflow={overflow}
      />

      <BrowserToolbarProfileDialogs
        pendingSwitchProfileId={pendingSwitchProfileId}
        onPendingSwitchChange={() => setPendingSwitchProfileId(undefined)}
        onConfirmSwitch={confirmSwitchProfile}
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
