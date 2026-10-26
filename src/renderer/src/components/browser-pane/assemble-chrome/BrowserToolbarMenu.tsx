import { useEffect, useLayoutEffect, useState } from 'react'
import { toast } from 'sonner'
import { emitBrowserCookieImportToast } from '@/lib/browser-cookie-import-toast'
import { useAppStore } from '@/store'
import { useMountedRef } from '@/hooks/useMountedRef'
import { shouldShowBrowserImportHint } from './browser-import-hint-visibility'
import type { BrowserViewportPresetId } from '../../../../../shared/browser-workspace-types'
import type {
  BrowserPageSiteDisplay,
  BrowserSiteColorScheme
} from '../../../../../shared/browser-site-display'
import type { BrowserPageZoomDirection } from '../../../../../shared/browser-page-zoom'
import { addBrowserPageZoomEventListener } from '../host-guest/browser-page-zoom'
import {
  browserViewportPresetToOverride,
  getBrowserViewportPreset
} from '../../../../../shared/browser-viewport-presets'
import { BrowserToolbarMenuDropdown } from './browser-toolbar-menu-dropdown'
import { BrowserToolbarProfileDialogs } from './browser-toolbar-profile-dialogs'
import { translate } from '@/i18n/i18n'
import type { BrowserChromeOverflowMenuProps } from './browser-chrome-folded-tools'

type BrowserToolbarMenuProps = {
  currentProfileId: string | null
  workspaceId: string
  browserPageId: string
  viewportPresetId: BrowserViewportPresetId | null
  onDestroyWebview: () => void
  isActive: boolean
  /** Set only on a local HTML page whose file the editor can open. */
  onOpenSourceFile?: (() => void) | null
  overflow: BrowserChromeOverflowMenuProps
}

export function BrowserToolbarMenu({
  currentProfileId,
  workspaceId,
  browserPageId,
  viewportPresetId,
  onDestroyWebview,
  isActive,
  onOpenSourceFile,
  overflow
}: BrowserToolbarMenuProps): React.JSX.Element {
  const browserSessionProfiles = useAppStore((s) => s.browserSessionProfiles)
  const detectedBrowsers = useAppStore((s) => s.detectedBrowsers)
  const switchBrowserTabProfile = useAppStore((s) => s.switchBrowserTabProfile)
  const createBrowserSessionProfile = useAppStore((s) => s.createBrowserSessionProfile)
  const importCookiesFromBrowser = useAppStore((s) => s.importCookiesFromBrowser)
  const importCookiesToProfile = useAppStore((s) => s.importCookiesToProfile)
  const fetchDetectedBrowsers = useAppStore((s) => s.fetchDetectedBrowsers)
  const browserSessionImportState = useAppStore((s) => s.browserSessionImportState)
  const setBrowserPageViewportPreset = useAppStore((s) => s.setBrowserPageViewportPreset)
  const browserCookieTourStepActive = useAppStore(
    (s) => s.activeContextualTourId === 'browser' && s.activeContextualTourStepIndex === 2
  )
  const browserImportHintHidden = useAppStore((s) => s.browserImportHintHidden)
  const persistedUIReady = useAppStore((s) => s.persistedUIReady)
  // Force overflow open for the tour only when the always-visible Import hint has been dismissed.
  const importHintVisible = shouldShowBrowserImportHint({
    persistedUIReady,
    browserImportHintHidden
  })
  const shouldForceMenuOpen = browserCookieTourStepActive && isActive && !importHintVisible

  const applyViewportPreset = (nextId: BrowserViewportPresetId | null): void => {
    setBrowserPageViewportPreset(browserPageId, nextId)
    const preset = getBrowserViewportPreset(nextId)
    const override = preset ? browserViewportPresetToOverride(preset) : null
    void window.api.browser.setViewportOverride({ browserPageId, override })
  }

  const [newProfileDialogOpen, setNewProfileDialogOpen] = useState(false)
  const [newProfileName, setNewProfileName] = useState('')
  const [isCreatingProfile, setIsCreatingProfile] = useState(false)
  const [pendingSwitchProfileId, setPendingSwitchProfileId] = useState<string | null | undefined>(
    undefined
  )
  const [menuOpen, setMenuOpen] = useState(false)
  const [siteDisplay, setSiteDisplay] = useState<BrowserPageSiteDisplay | null>(null)
  const mountedRef = useMountedRef()

  const showSiteDisplay = (request: Promise<BrowserPageSiteDisplay | null>): void => {
    void request.then((display) => {
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
    // Main handles invokes in order, so reading after the pane’s zoom command sees the new display.
    return addBrowserPageZoomEventListener((command) => {
      if (command.browserPageId === browserPageId) {
        void window.api.browser.getPageSiteDisplay({ browserPageId }).then((display) => {
          if (mountedRef.current) {
            setSiteDisplay(display)
          }
        })
      }
    })
  }, [browserPageId, menuOpen, mountedRef])

  useLayoutEffect(() => {
    // Only expose the hidden Import Cookies row when the tour reaches its fallback step.
    setMenuOpen(shouldForceMenuOpen)
  }, [shouldForceMenuOpen])

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
      translate(
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
            translate(
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
        translate(
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
          ? translate(
              'auto.components.browser.pane.BrowserToolbarMenu.c5f0e4d3b2a1',
              'Imported {{value0}} cookies from {{value1}} ({{value2}}).',
              {
                value0: result.summary.importedCookies,
                value1: browser?.label ?? browserFamily,
                value2: browserProfile
              }
            )
          : translate(
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
      toast.error(result.reason)
    }
  }

  const handleImportFromFile = async (): Promise<void> => {
    const result = await importCookiesToProfile(effectiveProfileId)
    if (result.ok) {
      emitBrowserCookieImportToast(
        result.summary,
        translate(
          'auto.components.browser.pane.BrowserToolbarMenu.53bbe3dab4',
          'Imported {{value0}} cookies from file.',
          { value0: result.summary.importedCookies }
        ),
        result
      )
    } else if (result.reason !== 'canceled') {
      toast.error(result.reason)
    }
  }

  return (
    <>
      <BrowserToolbarMenuDropdown
        browserPageId={browserPageId}
        menuOpen={menuOpen}
        onMenuOpenChange={handleMenuOpenChange}
        allProfiles={allProfiles}
        effectiveProfileId={effectiveProfileId}
        onSwitchProfile={handleSwitchProfile}
        onNewProfile={() => setNewProfileDialogOpen(true)}
        detectedBrowsers={detectedBrowsers}
        onFetchDetectedBrowsers={() => void fetchDetectedBrowsers()}
        browserSessionImportState={browserSessionImportState}
        onImportFromBrowser={(browserFamily, browserProfile) =>
          void handleImportFromBrowser(browserFamily, browserProfile)
        }
        onImportFromFile={() => void handleImportFromFile()}
        viewportPresetId={viewportPresetId}
        onApplyViewportPreset={applyViewportPreset}
        siteDisplay={siteDisplay}
        onZoomPage={zoomPage}
        onSetSiteColorScheme={setSiteColorScheme}
        onOpenSourceFile={onOpenSourceFile}
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
