import { useRef, useState } from 'react'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import BrowserAddressBar from '../address-bar/BrowserAddressBar'
import { BrowserChromeToolbar } from './browser-chrome-toolbar'
import { BrowserToolbarMenuDropdown } from './browser-toolbar-menu-dropdown'
import type { BrowserSessionProfile } from '../../../../../../shared/browser/workspaces/browser-workspace-types'

const noop = (): void => {}

const PROFILES: BrowserSessionProfile[] = [
  {
    id: 'default',
    scope: 'default',
    partition: 'persist:orca-browser',
    label: 'Default',
    source: null
  },
  {
    id: 'fixture-work',
    scope: 'isolated',
    partition: 'persist:orca-browser-fixture-work',
    label: 'Work',
    source: null
  }
]

const DETECTED_BROWSERS = [
  {
    family: 'chrome',
    label: 'Chrome',
    profiles: [
      { name: 'Person 1', directory: 'Default' },
      { name: 'Person 2', directory: 'Profile 1' }
    ],
    selectedProfile: 'Default'
  },
  {
    family: 'firefox',
    label: 'Firefox',
    profiles: [{ name: 'default-release', directory: 'default-release' }],
    selectedProfile: 'default-release'
  }
]

function Toolbar(): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  return (
    <div className="h-[560px]">
      <BrowserChromeToolbar
        closeTabOwner={{ worktreeId: 'fixture', browserPageId: 'fixture-page' }}
        controls={{
          canGoBack: true,
          canGoForward: false,
          goBack: noop,
          goForward: noop,
          reload: noop,
          navigate: noop
        }}
        addressSlot={
          <BrowserAddressBar
            pageId="fixture-page"
            value="localhost:5173/settings"
            inputRef={inputRef}
            onChange={noop}
            onSubmit={noop}
            onNavigate={noop}
          />
        }
        elementTools={{
          activeIntent: null,
          onStartIntent: noop,
          disabled: false,
          grabShortcutLabel: '⌘C',
          annotateShortcutLabel: '⇧⌘C',
          annotationCount: 0
        }}
        markup={{ active: false, disabled: false, onToggle: noop, canShowDiscoveryHint: false }}
        notes={{ onCopyAll: noop, onClear: noop }}
        overflowMenu={(overflow) => (
          <BrowserToolbarMenuDropdown
            extensionDiscoveryTarget={false}
            browserPageId="fixture-page"
            menuOpen={open}
            onMenuOpenChange={setOpen}
            profile={{
              browserPageId: 'fixture-page',
              allProfiles: PROFILES,
              effectiveProfileId: 'default',
              canRefreshFromChrome: true,
              onSwitchProfile: noop,
              onNewProfile: noop
            }}
            cookieImport={{
              browserPageId: 'fixture-page',
              effectiveProfileId: 'default',
              detectedBrowsers: DETECTED_BROWSERS,
              onFetchDetectedBrowsers: noop,
              browserSessionImportState: null,
              pageRoute: { kind: 'local' },
              onImportFromBrowser: noop,
              onImportFromFile: noop
            }}
            pageActions={{
              onFind: noop,
              onHardReload: noop,
              onOpenDevTools: noop,
              onOpenExternal: noop
            }}
            extensionsSub={null}
            viewportPresetId={null}
            onApplyViewportPreset={noop}
            siteDisplay={null}
            onZoomPage={noop}
            onSetSiteColorScheme={noop}
            overflow={overflow}
          />
        )}
      />
    </div>
  )
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 150))

async function openMenu(frame: HTMLElement): Promise<void> {
  frame.querySelector('button[aria-label="Browser menu"]')?.dispatchEvent(
    new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      pointerType: 'mouse'
    })
  )
  await settle()
}

async function openSub(frame: HTMLElement, label: string): Promise<void> {
  await openMenu(frame)
  const trigger = [
    ...frame.ownerDocument.querySelectorAll<HTMLElement>('[data-slot="dropdown-menu-sub-trigger"]')
  ].find((el) => el.textContent?.includes(label))
  trigger?.focus()
  trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
  await settle()
}

export const menuOpen = defineFixture({
  width: 640,
  render: () => <Toolbar />,
  interact: openMenu
})

export const importCookiesSubOpen = defineFixture({
  width: 640,
  render: () => <Toolbar />,
  interact: (frame) => openSub(frame, 'Import Cookies')
})

export const profileSubOpen = defineFixture({
  width: 640,
  render: () => <Toolbar />,
  interact: (frame) => openSub(frame, 'Profile')
})

export const narrowMenuOpen = defineFixture({
  width: 320,
  render: () => <Toolbar />,
  interact: openMenu
})

export const narrowImportCookiesSubOpen = defineFixture({
  width: 320,
  render: () => <Toolbar />,
  interact: (frame) => openSub(frame, 'Import Cookies')
})

export const narrowProfileSubOpen = defineFixture({
  width: 320,
  render: () => <Toolbar />,
  interact: (frame) => openSub(frame, 'Profile')
})
