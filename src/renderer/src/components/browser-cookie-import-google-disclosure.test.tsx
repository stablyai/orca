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
const {
  clearBrowserProfileGoogleCookiesMock,
  clearDefaultSessionCookiesMock,
  confirmMock,
  errorToastMock,
  successToastMock
} = vi.hoisted(() => ({
  clearBrowserProfileGoogleCookiesMock: vi.fn(),
  clearDefaultSessionCookiesMock: vi.fn(),
  confirmMock: vi.fn(),
  errorToastMock: vi.fn(),
  successToastMock: vi.fn()
}))

vi.mock('@/components/ui/dropdown-menu', () => dropdownMenuStubs())
vi.mock('../ui/dropdown-menu', () => dropdownMenuStubs())
vi.mock('@/components/ui/popover', () => popoverStubs())
vi.mock('@/components/ui/tooltip', () => tooltipStubs())
vi.mock('./ui/tooltip', () => tooltipStubs())
vi.mock('@/store', () => ({ useAppStore: appStoreStub() }))
// Why: the real hook returns a useCallback-stable value; a fresh fn per render would break deps.
vi.mock('@/components/confirmation-dialog-context', () => ({
  useConfirmationDialog: () => confirmMock
}))
vi.mock('../../store', () => ({ useAppStore: appStoreStub() }))
vi.mock('sonner', () => ({ toast: { success: successToastMock, error: errorToastMock } }))

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
    clearBrowserProfileGoogleCookiesMock.mockReset().mockResolvedValue(true)
    clearDefaultSessionCookiesMock.mockReset().mockResolvedValue(true)
    confirmMock.mockReset().mockResolvedValue(true)
    errorToastMock.mockReset()
    successToastMock.mockReset()
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
          profile={{ id: 'default', label: 'Default', partition: 'persist:default' } as never}
          detectedBrowsers={DETECTED_BROWSERS}
          importState={null}
          isActive
          executionHostLabel="Remote Mac"
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

  // Why (#14686): keying this off import metadata is a bad proxy for "this profile has cookies", so
  // the button stays enabled — which is exactly why it has to be confirm-gated instead.
  it('confirms before clearing every cookie in the profile, naming the real consequence', async () => {
    act(() =>
      root.render(
        <BrowserProfileRow
          profile={
            {
              id: 'default',
              label: 'Default',
              partition: 'persist:default',
              source: null
            } as never
          }
          detectedBrowsers={DETECTED_BROWSERS}
          importState={null}
          isActive
          isDefault
          executionHostLabel="Remote Mac"
          onSelect={vi.fn()}
        />
      )
    )

    const clearButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.querySelector('.lucide-trash-2')
    )
    expect(clearButton?.disabled).toBe(false)
    expect(clearButton?.getAttribute('aria-label')).toBe('Clear profile cookies')

    act(() => clearButton?.click())

    await vi.waitFor(() => expect(confirmMock).toHaveBeenCalledOnce())
    const options = confirmMock.mock.calls[0]?.[0]
    expect(options.title).toBe('Clear all cookies for this profile?')
    expect(options.description).toBe(
      'This deletes every cookie in the Default browser profile on Remote Mac and signs you out of every site in it, including Google. Cookies from a recent import that were still waiting for a restart go too, and Orca stops showing which browser this profile was imported from. Import again to restore the cookies.'
    )
    expect(options.confirmVariant).toBe('destructive')
    await vi.waitFor(() => expect(clearDefaultSessionCookiesMock).toHaveBeenCalledOnce())
  })

  it('does not clear any cookies when the confirmation is declined', async () => {
    confirmMock.mockResolvedValue(false)
    act(() =>
      root.render(
        <BrowserProfileRow
          profile={{ id: 'default', label: 'Default', partition: 'persist:default' } as never}
          detectedBrowsers={DETECTED_BROWSERS}
          importState={null}
          isActive
          isDefault
          executionHostLabel="Remote Mac"
          onSelect={vi.fn()}
        />
      )
    )

    const clearButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Clear profile cookies"]'
    )
    act(() => clearButton?.click())
    const clearGoogleItem = Array.from(
      container.querySelectorAll('[data-testid="menu-item"]')
    ).find((item) => item.textContent === 'Clear Google cookies')
    act(() => (clearGoogleItem as HTMLElement).click())

    await vi.waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(2))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(clearDefaultSessionCookiesMock).not.toHaveBeenCalled()
    expect(clearBrowserProfileGoogleCookiesMock).not.toHaveBeenCalled()
  })

  it('confirms before clearing Google cookies and promises other sites are kept', async () => {
    act(() =>
      root.render(
        <BrowserProfileRow
          profile={{ id: 'work', label: 'Work', partition: 'persist:work' } as never}
          detectedBrowsers={DETECTED_BROWSERS}
          importState={null}
          isActive
          executionHostLabel="Remote Mac"
          onSelect={vi.fn()}
        />
      )
    )

    const clearGoogleItem = Array.from(
      container.querySelectorAll('[data-testid="menu-item"]')
    ).find((item) => item.textContent === 'Clear Google cookies')
    expect(clearGoogleItem).toBeDefined()
    // Why: the stub flattens menus, so without asserting containment and the trigger, inlining this
    // destructive item bare onto the row as a one-click control would still pass.
    expect(clearGoogleItem?.closest('[data-testid="menu-content"]')).not.toBeNull()
    expect(container.querySelector('button[aria-label="More actions for Work"]')).not.toBeNull()
    act(() => (clearGoogleItem as HTMLElement).click())

    await vi.waitFor(() => expect(confirmMock).toHaveBeenCalledOnce())
    const options = confirmMock.mock.calls[0]?.[0]
    expect(options.title).toBe('Clear Google cookies?')
    expect(options.description).toBe(
      'This signs you out of Google in the Work browser profile on Remote Mac. Cookies for other sites are kept, though an import still waiting for a restart may have to be run again.'
    )
    expect(options.confirmVariant).toBe('destructive')
    await vi.waitFor(() =>
      expect(clearBrowserProfileGoogleCookiesMock).toHaveBeenCalledWith('work')
    )
  })

  it('does not select the profile when the clear action handles a keyboard event', () => {
    const onSelect = vi.fn()
    act(() =>
      root.render(
        <BrowserProfileRow
          profile={{ id: 'default', label: 'Default', partition: 'persist:default' } as never}
          detectedBrowsers={DETECTED_BROWSERS}
          importState={null}
          isActive
          isDefault
          executionHostLabel="Remote Mac"
          onSelect={onSelect}
        />
      )
    )

    const clearButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Clear profile cookies"]'
    )
    act(() => {
      clearButton?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      )
    })

    expect(onSelect).not.toHaveBeenCalled()
  })

  it('disables the clear action while pending and reports failure', async () => {
    let resolveClear: (cleared: boolean) => void = () => undefined
    clearDefaultSessionCookiesMock.mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolveClear = resolve
      })
    )
    act(() =>
      root.render(
        <BrowserProfileRow
          profile={{ id: 'default', label: 'Default', partition: 'persist:default' } as never}
          detectedBrowsers={DETECTED_BROWSERS}
          importState={null}
          isActive
          isDefault
          executionHostLabel="Remote Mac"
          onSelect={vi.fn()}
        />
      )
    )

    const clearButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Clear profile cookies"]'
    )
    await act(async () => {
      clearButton?.click()
      await vi.waitFor(() => expect(clearDefaultSessionCookiesMock).toHaveBeenCalledOnce())
    })
    expect(clearButton?.disabled).toBe(true)

    await act(async () => {
      resolveClear(false)
      await vi.waitFor(() => expect(errorToastMock).toHaveBeenCalled())
    })
    expect(clearButton?.disabled).toBe(false)
    expect(errorToastMock).toHaveBeenCalledWith('Failed to clear profile cookies.')
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
    DropdownMenuContent: ({ children }: { children?: ReactNode }): ReactNode => (
      <div data-testid="menu-content">{children}</div>
    ),
    DropdownMenuItem: ({
      children,
      onSelect
    }: {
      children?: ReactNode
      onSelect?: () => void
    }): ReactNode => (
      <div data-testid="menu-item" onClick={() => onSelect?.()}>
        {children}
      </div>
    ),
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

function tooltipStubs(): Record<string, unknown> {
  const passthrough = ({ children }: { children?: ReactNode }): ReactNode => children
  return { Tooltip: passthrough, TooltipContent: passthrough, TooltipTrigger: passthrough }
}

function appStoreStub(): unknown {
  const state = {
    browserImportHintHidden: false,
    browserSessionImportState: null,
    clearBrowserProfileGoogleCookies: clearBrowserProfileGoogleCookiesMock,
    clearDefaultSessionCookies: clearDefaultSessionCookiesMock,
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
