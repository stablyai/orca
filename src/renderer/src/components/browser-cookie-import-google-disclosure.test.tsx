/**
 * @vitest-environment happy-dom
 *
 * STA-3811: imports never touch the Google cookie family, so every import menu must disclose it
 * at the moment of decision.
 */
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import en from '@/i18n/locales/en.json'

const DISCLOSURE_TITLE = "Google logins aren't imported"
const DISCLOSURE_DESCRIPTION = 'Sign in to Google directly in Orca.'

vi.mock('@/components/ui/dropdown-menu', () => dropdownMenuStubs())
vi.mock('../ui/dropdown-menu', () => dropdownMenuStubs())
vi.mock('@/components/ui/popover', () => popoverStubs())
vi.mock('@/store', () => ({ useAppStore: appStoreStub() }))
vi.mock('../../store', () => ({ useAppStore: appStoreStub() }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { BrowserCookieImportDisclosure } from './BrowserCookieImportDisclosure'
import { BrowserImportHintButton } from './browser-pane/assemble-chrome/BrowserImportHintButton'
import { BrowserToolbarMenuDropdown } from './browser-pane/assemble-chrome/browser-toolbar-menu-dropdown'
import { BrowserProfileRow } from './settings/BrowserProfileRow'
import { BrowserUseCookieImportStep } from './settings/BrowserUseCookieImportStep'

const DETECTED_BROWSERS = [
  {
    family: 'chrome',
    label: 'Google Chrome',
    profiles: [{ name: 'Default', directory: 'Default' }],
    selectedProfile: 'Default'
  }
]

describe('cookie-import Google disclosure footer', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it.each([
    [
      'browser toolbar overflow',
      () => (
        <BrowserToolbarMenuDropdown
          menuOpen
          onMenuOpenChange={vi.fn()}
          allProfiles={[]}
          effectiveProfileId="default"
          onSwitchProfile={vi.fn()}
          onNewProfile={vi.fn()}
          detectedBrowsers={DETECTED_BROWSERS}
          onFetchDetectedBrowsers={vi.fn()}
          browserSessionImportState={null}
          onImportFromBrowser={vi.fn()}
          onImportFromFile={vi.fn()}
          viewportPresetId={null}
          onApplyViewportPreset={vi.fn()}
        />
      )
    ],
    ['browser toolbar hint', () => <BrowserImportHintButton profileId="default" />],
    [
      'Settings browser-use setup',
      () => (
        <BrowserUseCookieImportStep
          cookiesImported={false}
          isImportingDefault={false}
          step3Blocked={false}
          sourceLabel={null}
        />
      )
    ],
    [
      'Settings browser-profile row',
      () => (
        <BrowserProfileRow
          profile={{ id: 'default', name: 'Default', partition: 'persist:default' } as never}
          detectedBrowsers={DETECTED_BROWSERS}
          importState={null}
          isActive
          onSelect={vi.fn()}
        />
      )
    ]
  ] satisfies [string, () => ReactNode][])('is shown in the %s menu', (_name, renderSurface) => {
    act(() => root.render(renderSurface()))

    expect(container.textContent).toContain(DISCLOSURE_TITLE)
    expect(container.textContent).toContain(DISCLOSURE_DESCRIPTION)
  })

  it('renders the icon and separator as non-interactive footer chrome', () => {
    act(() => root.render(<BrowserCookieImportDisclosure />))

    const label = container.querySelector('[data-testid="dropdown-menu-label"]')
    expect(label?.querySelector('svg')).not.toBeNull()
    expect(label?.previousElementSibling?.tagName).toBe('HR')
  })

  it('reads the footer copy from the catalog', () => {
    expect(catalogEntry('auto.components.BrowserCookieImportDisclosure.title')).toBe(
      DISCLOSURE_TITLE
    )
    expect(catalogEntry('auto.components.BrowserCookieImportDisclosure.description')).toBe(
      DISCLOSURE_DESCRIPTION
    )
  })
})

function catalogEntry(key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        typeof node === 'object' && node !== null
          ? (node as Record<string, unknown>)[part]
          : undefined,
      en
    )
}

function dropdownMenuStubs(): Record<string, unknown> {
  const passthrough = ({ children }: { children?: ReactNode }): ReactNode => children
  const block = ({ children }: { children?: ReactNode }): ReactNode => <div>{children}</div>
  return {
    DropdownMenu: passthrough,
    DropdownMenuContent: block,
    DropdownMenuItem: block,
    DropdownMenuLabel: ({ children }: { children?: ReactNode }): ReactNode => (
      <div data-testid="dropdown-menu-label">{children}</div>
    ),
    DropdownMenuPortal: passthrough,
    DropdownMenuRadioGroup: passthrough,
    DropdownMenuRadioItem: block,
    DropdownMenuSeparator: () => <hr />,
    DropdownMenuSub: passthrough,
    DropdownMenuSubContent: block,
    DropdownMenuSubTrigger: block,
    DropdownMenuTrigger: passthrough
  }
}

function popoverStubs(): Record<string, unknown> {
  const passthrough = ({ children }: { children?: ReactNode }): ReactNode => children
  const block = ({ children }: { children?: ReactNode }): ReactNode => <div>{children}</div>
  return { Popover: passthrough, PopoverContent: block, PopoverTrigger: passthrough }
}

function appStoreStub(): unknown {
  const state = {
    browserImportHintHidden: false,
    browserSessionImportState: null,
    detectedBrowsers: [
      {
        family: 'chrome',
        label: 'Google Chrome',
        profiles: [{ name: 'Default', directory: 'Default' }],
        selectedProfile: 'Default'
      }
    ],
    detectedBrowsersLoaded: true,
    fetchDetectedBrowsers: vi.fn(),
    importCookiesFromBrowser: vi.fn(),
    importCookiesToProfile: vi.fn(),
    openSettingsTarget: vi.fn(),
    openSettingsPage: vi.fn(),
    persistedUIReady: true,
    setBrowserImportHintHidden: vi.fn(),
    settingsSearchQuery: ''
  }
  const useAppStore = (selector?: (s: typeof state) => unknown): unknown =>
    selector ? selector(state) : state
  useAppStore.getState = (): typeof state => state
  return useAppStore
}
