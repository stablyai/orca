/**
 * @vitest-environment happy-dom
 *
 * STA-3811: imports never touch the Google cookie family, so both import menus must say so at
 * the moment of decision. Covers the browser toolbar menu and the Settings profile row.
 */
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import en from '@/i18n/locales/en.json'

const DISCLOSURE = 'Google requires signing in directly - imports skip it.'

vi.mock('@/components/ui/dropdown-menu', () => dropdownMenuStubs())
vi.mock('../ui/dropdown-menu', () => dropdownMenuStubs())
vi.mock('@/store', () => ({ useAppStore: appStoreStub() }))
vi.mock('../../store', () => ({ useAppStore: appStoreStub() }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { BrowserToolbarMenuDropdown } from './browser-pane/browser-toolbar-menu-dropdown'
import { BrowserProfileRow } from './settings/BrowserProfileRow'

const DETECTED_BROWSERS = [
  {
    family: 'chrome',
    label: 'Google Chrome',
    profiles: [{ name: 'Default', directory: 'Default' }],
    selectedProfile: 'Default'
  }
]

describe('cookie-import Google disclosure caption', () => {
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

  it('is shown in the browser toolbar import menu', () => {
    act(() => {
      root.render(
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
    })

    expect(container.textContent).toContain(DISCLOSURE)
  })

  it('is shown in the Settings browser-profile import menu', () => {
    act(() => {
      root.render(
        <BrowserProfileRow
          profile={{ id: 'default', name: 'Default', partition: 'persist:default' } as never}
          detectedBrowsers={DETECTED_BROWSERS}
          importState={null}
          isActive
          onSelect={vi.fn()}
        />
      )
    })

    expect(container.textContent).toContain(DISCLOSURE)
  })

  // Why: the rendered text comes from the catalog, not the translate() fallback, so a copy
  // drift in en.json alone would otherwise slip through both render assertions.
  it('reads the same copy from the catalog on both surfaces', () => {
    expect(catalogEntry('auto.components.browser.pane.BrowserToolbarMenu.c186b4d890')).toBe(
      DISCLOSURE
    )
    expect(catalogEntry('auto.components.settings.BrowserProfileRow.654a0c2073')).toBe(DISCLOSURE)
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
    DropdownMenuLabel: block,
    DropdownMenuPortal: passthrough,
    DropdownMenuRadioGroup: passthrough,
    DropdownMenuRadioItem: block,
    DropdownMenuSeparator: () => null,
    DropdownMenuSub: passthrough,
    DropdownMenuSubContent: block,
    DropdownMenuSubTrigger: block,
    DropdownMenuTrigger: passthrough
  }
}

function appStoreStub(): unknown {
  const state = {
    fetchDetectedBrowsers: vi.fn(),
    openSettingsTarget: vi.fn(),
    openSettingsPage: vi.fn()
  }
  const useAppStore = (selector?: (s: typeof state) => unknown): unknown =>
    selector ? selector(state) : state
  useAppStore.getState = (): typeof state => state
  return useAppStore
}
