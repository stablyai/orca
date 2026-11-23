import { useRef, useState } from 'react'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import BrowserAddressBar from '../address-bar/BrowserAddressBar'
import { BrowserChromeToolbar } from './browser-chrome-toolbar'
import { BrowserToolbarMenuDropdown } from './browser-toolbar-menu-dropdown'
import type { BrowserSessionProfile } from '../../../../../../shared/browser/workspaces/browser-workspace-types'
import type { DetectedBrowserEntry } from '../profile-routing/browser-toolbar-import-cookies-item'
import type { BrowserCookieImportSource } from '../profile-routing/browser-cookie-import-picker-rows'
import { rememberBrowserCookieImportLastUsed } from '../profile-routing/browser-cookie-import-last-used'

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

const CHROME_PROFILE_NAMES = [
  'Person 1',
  'Work',
  'Personal',
  'Design',
  'Testing',
  'Side project',
  'Client A',
  'Client B',
  'Research',
  'Demo',
  'Staging',
  'Old'
]

const MANY_BROWSERS: DetectedBrowserEntry[] = [
  {
    family: 'chrome',
    label: 'Google Chrome',
    profiles: CHROME_PROFILE_NAMES.map((name, index) => ({
      name,
      directory: index === 0 ? 'Default' : `Profile ${index}`
    })),
    selectedProfile: 'Default'
  },
  {
    family: 'edge',
    label: 'Microsoft Edge',
    profiles: [
      { name: 'Person 1', directory: 'Default' },
      { name: 'Work', directory: 'Profile 1' }
    ],
    selectedProfile: 'Default'
  },
  {
    family: 'comet',
    label: 'Comet',
    profiles: [{ name: 'Person 1', directory: 'Default' }],
    selectedProfile: 'Default'
  },
  {
    family: 'safari',
    label: 'Safari',
    profiles: [{ name: 'Default', directory: 'Default' }],
    selectedProfile: 'Default'
  }
]

const ONE_PROFILE: DetectedBrowserEntry[] = [
  {
    family: 'chrome',
    label: 'Google Chrome',
    profiles: [{ name: 'Person 1', directory: 'Default' }],
    selectedProfile: 'Default'
  }
]

/** What the picker's last import was, as it reads it from this window's storage on open. */
function seedLastUsed(source: BrowserCookieImportSource | null): void {
  if (source) {
    rememberBrowserCookieImportLastUsed(source)
  } else {
    window.localStorage.removeItem('orca.browser.cookieImport.lastUsedSource')
  }
}

/** Shows what an import would do in place of the real one, for the interaction check. */
function FixtureImportLog({ entries }: { entries: string[] }): React.JSX.Element {
  return (
    <output
      data-testid="fixture-import-log"
      className="block px-2 pt-2 text-xs text-muted-foreground"
    >
      {entries.at(-1) ?? ''}
    </output>
  )
}

function Toolbar({
  detectedBrowsers = MANY_BROWSERS
}: {
  detectedBrowsers?: DetectedBrowserEntry[]
}): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [imports, setImports] = useState<string[]>([])
  const log = (entry: string): void => setImports((previous) => [...previous, entry])
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
              onSwitchProfile: noop,
              onNewProfile: noop
            }}
            cookieImport={{
              browserPageId: 'fixture-page',
              effectiveProfileId: 'default',
              detectedBrowsers,
              onFetchDetectedBrowsers: noop,
              browserSessionImportState: null,
              pageRoute: { kind: 'local' },
              pickerOpen,
              onPickerOpenChange: setPickerOpen,
              onImportFromBrowser: (family, profile) =>
                log(`browser:${family}${profile ? `:${profile}` : ''}`),
              onImportFromFile: () => log('file')
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
      <FixtureImportLog entries={imports} />
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

async function openImportPicker(frame: HTMLElement): Promise<void> {
  await openMenu(frame)
  const row = frame.ownerDocument.querySelector<HTMLElement>(
    '[data-contextual-tour-target="browser-import-cookies-control"]'
  )
  row?.click()
  await settle()
}

function typeInPicker(frame: HTMLElement, text: string): void {
  const input = frame.ownerDocument.querySelector<HTMLInputElement>(
    '[data-testid="browser-cookie-import-picker"] input'
  )
  if (!input) {
    return
  }
  // React tracks the value itself; set it through the native setter so onChange sees the edit.
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, text)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

const LAST_USED: BrowserCookieImportSource = { family: 'chrome', profile: 'Profile 1' }

export const menuOpen = defineFixture({
  width: 640,
  render: () => <Toolbar />,
  interact: openMenu
})

export const importPickerOpen = defineFixture({
  width: 640,
  setup: () => seedLastUsed(LAST_USED),
  render: () => <Toolbar />,
  interact: openImportPicker
})

export const importPickerFiltered = defineFixture({
  width: 640,
  setup: () => seedLastUsed(LAST_USED),
  render: () => <Toolbar />,
  interact: async (frame) => {
    await openImportPicker(frame)
    typeInPicker(frame, 'client')
    await settle()
  }
})

export const importPickerNoMatches = defineFixture({
  width: 640,
  setup: () => seedLastUsed(LAST_USED),
  render: () => <Toolbar />,
  interact: async (frame) => {
    await openImportPicker(frame)
    typeInPicker(frame, 'zzz')
    await settle()
  }
})

export const importPickerNoLastUsed = defineFixture({
  width: 640,
  setup: () => seedLastUsed(null),
  render: () => <Toolbar />,
  interact: openImportPicker
})

export const importPickerOneProfile = defineFixture({
  width: 640,
  setup: () => seedLastUsed(null),
  render: () => <Toolbar detectedBrowsers={ONE_PROFILE} />,
  interact: openImportPicker
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

export const narrowImportPickerOpen = defineFixture({
  width: 320,
  setup: () => seedLastUsed(LAST_USED),
  render: () => <Toolbar />,
  interact: openImportPicker
})

export const narrowProfileSubOpen = defineFixture({
  width: 320,
  render: () => <Toolbar />,
  interact: (frame) => openSub(frame, 'Profile')
})
