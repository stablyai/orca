import { useCallback, useRef, useState, type MutableRefObject } from 'react'
import type { GlobalSettings } from '../../../../shared/types'
import { useAppStore } from '../../store'
import { matchesSettingsSearch } from './settings-search'
import { getBrowserPaneSearchEntries, getBrowserLinkRoutingDescription } from './browser-search'
import { getBrowserUsePaneSearchEntries } from './browser-use-search'
import { getBrowserPaneCombinedSearchEntries } from './browser-pane-search'
import { BrowserHomePageSetting } from './BrowserHomePageSetting'
import { BrowserDefaultZoomSetting } from './BrowserDefaultZoomSetting'
import { BrowserUseSetup } from './BrowserUsePane'
import { BrowserSearchEngineSetting } from './BrowserSearchEngineSetting'
import { BrowserLinkRoutingSetting } from './BrowserLinkRoutingSetting'
import { BrowserSessionCookiesSection } from './BrowserSessionCookiesSection'
import { BrowserNewProfileDialog } from './BrowserNewProfileDialog'
import {
  createBrowserHomePageDraftState,
  resolveBrowserHomePageDraftState
} from './browser-home-page-draft-state'
import { isMacUserAgent } from '@/components/terminal-pane/pane-helpers'
export { getBrowserPaneCombinedSearchEntries }

type BrowserPaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  onOpenComputerUse?: () => void
}

function cancelBrowserSessionCookieScrollFrames(frameIds: MutableRefObject<number[]>): void {
  for (const frameId of frameIds.current) {
    cancelAnimationFrame(frameId)
  }
  frameIds.current = []
}

export function BrowserPane({
  settings,
  updateSettings,
  onOpenComputerUse
}: BrowserPaneProps): React.JSX.Element {
  const searchQuery = useAppStore((s) => s.settingsSearchQuery)
  const browserDefaultUrl = useAppStore((s) => s.browserDefaultUrl)
  const setBrowserDefaultUrl = useAppStore((s) => s.setBrowserDefaultUrl)
  const browserDefaultSearchEngine = useAppStore((s) => s.browserDefaultSearchEngine)
  const setBrowserDefaultSearchEngine = useAppStore((s) => s.setBrowserDefaultSearchEngine)
  const browserDefaultZoomLevel = useAppStore((s) => s.browserDefaultZoomLevel)
  const setBrowserDefaultZoomLevel = useAppStore((s) => s.setBrowserDefaultZoomLevel)
  const browserSessionProfiles = useAppStore((s) => s.browserSessionProfiles)
  const detectedBrowsers = useAppStore((s) => s.detectedBrowsers)
  const browserSessionImportState = useAppStore((s) => s.browserSessionImportState)
  const defaultBrowserSessionProfileId = useAppStore((s) => s.defaultBrowserSessionProfileId)
  const setDefaultBrowserSessionProfileId = useAppStore((s) => s.setDefaultBrowserSessionProfileId)
  const defaultProfile = browserSessionProfiles.find((p) => p.id === 'default')
  const nonDefaultProfiles = browserSessionProfiles.filter((p) => p.scope !== 'default')
  const persistedHomePageDraft = browserDefaultUrl ?? ''
  const [homePageDraftState, setHomePageDraftState] = useState(() =>
    createBrowserHomePageDraftState(persistedHomePageDraft)
  )
  const [newProfileDialogOpen, setNewProfileDialogOpen] = useState(false)
  const sessionCookieScrollFrameIdsRef = useRef<number[]>([])
  const resolvedHomePageDraftState = resolveBrowserHomePageDraftState(
    homePageDraftState,
    persistedHomePageDraft
  )

  if (resolvedHomePageDraftState !== homePageDraftState) {
    setHomePageDraftState(resolvedHomePageDraftState)
  }
  const homePageDraft = resolvedHomePageDraftState.value
  const setHomePageDraft = (value: string): void => {
    setHomePageDraftState((current) => ({ ...current, value }))
  }

  const setBrowserPaneRootNode = useCallback((node: HTMLDivElement | null) => {
    if (node !== null) {
      return
    }
    cancelBrowserSessionCookieScrollFrames(sessionCookieScrollFrameIdsRef)
  }, [])

  const selectedSearchEngine = browserDefaultSearchEngine ?? 'google'

  const showHomePage = matchesSettingsSearch(searchQuery, [getBrowserPaneSearchEntries()[0]])
  const showSearchEngine = matchesSettingsSearch(searchQuery, [getBrowserPaneSearchEntries()[1]])
  const showDefaultZoom = matchesSettingsSearch(searchQuery, [getBrowserPaneSearchEntries()[2]])
  const showLinkRouting = matchesSettingsSearch(searchQuery, [getBrowserPaneSearchEntries()[3]])
  const showCookies = matchesSettingsSearch(searchQuery, [getBrowserPaneSearchEntries()[4]])
  const showBrowserUse = matchesSettingsSearch(searchQuery, getBrowserUsePaneSearchEntries())
  const isMac = isMacUserAgent()
  const linkRoutingDescription = getBrowserLinkRoutingDescription({ isMac })

  const requestSessionCookieScrollFrame = (callback: FrameRequestCallback): void => {
    let completed = false
    let frameId: number | undefined
    frameId = requestAnimationFrame((timestamp) => {
      completed = true
      if (frameId !== undefined) {
        sessionCookieScrollFrameIdsRef.current = sessionCookieScrollFrameIdsRef.current.filter(
          (pendingFrameId) => pendingFrameId !== frameId
        )
      }
      callback(timestamp)
    })
    if (!completed) {
      sessionCookieScrollFrameIdsRef.current.push(frameId)
    }
  }

  const scrollToSessionCookies = (): void => {
    cancelBrowserSessionCookieScrollFrames(sessionCookieScrollFrameIdsRef)
    useAppStore.getState().setSettingsSearchQuery('')
    requestSessionCookieScrollFrame(() => {
      requestSessionCookieScrollFrame(() => {
        const el = document.getElementById('browser-session-cookies')
        if (!el) {
          return
        }
        el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      })
    })
  }

  return (
    <div ref={setBrowserPaneRootNode} className="space-y-6">
      {showBrowserUse ? (
        <BrowserUseSetup
          onConfigureMoreBrowsers={scrollToSessionCookies}
          onOpenComputerUse={onOpenComputerUse}
        />
      ) : null}

      {showHomePage ? (
        <BrowserHomePageSetting
          value={homePageDraft}
          onChange={setHomePageDraft}
          onSave={(url) => {
            setBrowserDefaultUrl(url)
            setHomePageDraftState(createBrowserHomePageDraftState(url ?? ''))
          }}
        />
      ) : null}

      {showSearchEngine ? (
        <BrowserSearchEngineSetting
          selectedSearchEngine={selectedSearchEngine}
          onSearchEngineChange={(engine) => {
            setBrowserDefaultSearchEngine(engine === 'google' ? null : engine)
          }}
        />
      ) : null}

      {showDefaultZoom ? (
        <BrowserDefaultZoomSetting
          value={browserDefaultZoomLevel}
          onChange={setBrowserDefaultZoomLevel}
        />
      ) : null}

      {showLinkRouting ? (
        <BrowserLinkRoutingSetting
          settings={settings}
          linkRoutingDescription={linkRoutingDescription}
          isMac={isMac}
          updateSettings={updateSettings}
        />
      ) : null}

      {showCookies ? (
        <BrowserSessionCookiesSection
          defaultProfile={defaultProfile}
          nonDefaultProfiles={nonDefaultProfiles}
          detectedBrowsers={detectedBrowsers}
          importState={browserSessionImportState}
          defaultBrowserSessionProfileId={defaultBrowserSessionProfileId}
          onAddProfile={() => setNewProfileDialogOpen(true)}
          onSelectDefaultProfile={() => setDefaultBrowserSessionProfileId(null)}
          onSelectProfile={setDefaultBrowserSessionProfileId}
        />
      ) : null}

      <BrowserNewProfileDialog open={newProfileDialogOpen} onOpenChange={setNewProfileDialogOpen} />
    </div>
  )
}
