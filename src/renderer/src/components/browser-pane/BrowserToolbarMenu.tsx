import { useLayoutEffect, useState } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { useMountedRef } from '@/hooks/useMountedRef'
import { shouldShowBrowserImportHint } from './browser-import-hint-visibility'
import type { BrowserViewportPresetId } from '../../../../shared/types'
import {
  browserViewportPresetToOverride,
  getBrowserViewportPreset
} from '../../../../shared/browser-viewport-presets'
import { BrowserToolbarMenuDropdown } from './browser-toolbar-menu-dropdown'
import { BrowserToolbarProfileDialogs } from './browser-toolbar-profile-dialogs'
import { translate } from '@/i18n/i18n'

type BrowserToolbarMenuProps = {
  currentProfileId: string | null
  workspaceId: string
  browserPageId: string
  viewportPresetId: BrowserViewportPresetId | null
  onDestroyWebview: () => void
  isActive: boolean
}

export function BrowserToolbarMenu({
  currentProfileId,
  workspaceId,
  browserPageId,
  viewportPresetId,
  onDestroyWebview,
  isActive
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
  // The tour prefers the always-visible Import button; only force this overflow
  // menu open to expose Import Cookies once that hint button is dismissed.
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
  const mountedRef = useMountedRef()

  useLayoutEffect(() => {
    // Why: step 3 falls back to the Import Cookies row inside this menu, so open
    // it only when the tour reaches that step and the hint button is hidden.
    setMenuOpen(shouldForceMenuOpen)
  }, [shouldForceMenuOpen])

  const handleMenuOpenChange = (open: boolean): void => {
    if (shouldForceMenuOpen && !open) {
      return
    }
    setMenuOpen(open)
  }

  const effectiveProfileId = currentProfileId ?? 'default'

  const defaultProfile = browserSessionProfiles.find((p) => p.id === 'default')
  // Why: Default profile always appears first in the list and cannot be deleted.
  // Non-default profiles follow in their natural order.
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
    // Why: Must destroy before store update. The webviewRegistry is keyed by
    // workspace ID (stable across switches). Without explicit destroy, the mount
    // effect would reclaim the old webview with the stale partition.
    onDestroyWebview()
    switchBrowserTabProfile(workspaceId, pendingSwitchProfileId)
    const profile = browserSessionProfiles.find((p) => p.id === targetId)
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
      switchBrowserTabProfile(workspaceId, profile.id)
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
      toast.success(
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
            )
      )
    } else {
      toast.error(result.reason)
    }
  }

  const handleImportFromFile = async (): Promise<void> => {
    const result = await importCookiesToProfile(effectiveProfileId)
    if (result.ok) {
      toast.success(
        translate(
          'auto.components.browser.pane.BrowserToolbarMenu.53bbe3dab4',
          'Imported {{value0}} cookies from file.',
          { value0: result.summary.importedCookies }
        )
      )
    } else if (result.reason !== 'canceled') {
      toast.error(result.reason)
    }
  }

  return (
    <>
      <BrowserToolbarMenuDropdown
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
      />

      <BrowserToolbarProfileDialogs
        pendingSwitchProfileId={pendingSwitchProfileId}
        onPendingSwitchChange={() => setPendingSwitchProfileId(undefined)}
        onConfirmSwitch={confirmSwitchProfile}
        newProfileDialogOpen={newProfileDialogOpen}
        onNewProfileDialogOpenChange={setNewProfileDialogOpen}
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
