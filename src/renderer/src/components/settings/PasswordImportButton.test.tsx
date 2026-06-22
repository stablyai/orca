// @vitest-environment happy-dom

// Tests for PasswordImportButton.
//
// Approach: render into DOM via createRoot + act (same as VoicePane.test.tsx /
// AppearancePane.test.tsx). The Radix DropdownMenu is mocked so the content is
// always visible (no portal, no open/close state) — this avoids the happy-dom
// portal gotchas while still exercising all real component logic.
//
// Modeled on: VoicePane.test.tsx (window.api + sonner setup) and
//             WorktreeCardMeta.interaction.test.tsx (DropdownMenu DOM mock).

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  DetectedImportBrowser,
  PasswordImportResult
} from '../../../../shared/browser-credential-types'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, _vars?: Record<string, unknown>) => fallback
}))

const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: toastMocks
}))

// Mock the Button so the trigger renders as a plain <button>.
vi.mock('../ui/button', () => ({
  Button: ({
    children,
    disabled,
    ...rest
  }: {
    children: ReactNode
    disabled?: boolean
    [key: string]: unknown
  }) => (
    <button data-testid="import-trigger" disabled={disabled} {...rest}>
      {children}
    </button>
  )
}))

// Capture the onOpenChange callback so tests can trigger it, and always render
// the content so menu items are always in the DOM (no portal / open gate).
const dropdownCallbacks = {
  onOpenChange: undefined as ((open: boolean) => void) | undefined
}

vi.mock('../ui/dropdown-menu', () => ({
  DropdownMenu: ({
    children,
    onOpenChange
  }: {
    children: ReactNode
    onOpenChange?: (open: boolean) => void
  }) => {
    dropdownCallbacks.onOpenChange = onOpenChange
    return <div data-testid="dropdown-root">{children}</div>
  },
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => (
    <div data-testid="dropdown-trigger">{children}</div>
  ),
  DropdownMenuContent: ({ children }: { children: ReactNode }) => (
    <div data-testid="dropdown-content">{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    onSelect,
    disabled
  }: {
    children: ReactNode
    onSelect?: () => void
    disabled?: boolean
  }) => (
    <button
      data-testid="menu-item"
      data-disabled={disabled ? 'true' : undefined}
      disabled={disabled}
      onClick={() => onSelect?.()}
    >
      {children}
    </button>
  ),
  DropdownMenuPortal: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuSub: ({ children }: { children: ReactNode }) => (
    <div data-testid="menu-sub">{children}</div>
  ),
  DropdownMenuSubTrigger: ({ children }: { children: ReactNode }) => (
    <div data-testid="menu-sub-trigger">{children}</div>
  ),
  DropdownMenuSubContent: ({ children }: { children: ReactNode }) => (
    <div data-testid="menu-sub-content">{children}</div>
  )
}))

// ---------------------------------------------------------------------------
// Import after mocks are set up
// ---------------------------------------------------------------------------

import { PasswordImportButton } from './PasswordImportButton'

// ---------------------------------------------------------------------------
// window.api helpers
// ---------------------------------------------------------------------------

const apiMocks = {
  detectImportBrowsers: vi.fn<() => Promise<DetectedImportBrowser[]>>(),
  importFromBrowser:
    vi.fn<
      (args: { browserFamily: string; browserProfile?: string }) => Promise<PasswordImportResult>
    >()
}

function installWindowApi(): void {
  Object.assign(window, {
    api: {
      browser: {
        credentials: {
          detectImportBrowsers: apiMocks.detectImportBrowsers,
          importFromBrowser: apiMocks.importFromBrowser
        }
      }
    }
  })
}

// ---------------------------------------------------------------------------
// Render helper
// ---------------------------------------------------------------------------

const mountedRoots: Root[] = []

async function renderButton(
  props: { disabled: boolean; onImported: () => void } = {
    disabled: false,
    onImported: vi.fn()
  }
): Promise<HTMLDivElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mountedRoots.push(root)

  await act(async () => {
    root.render(<PasswordImportButton disabled={props.disabled} onImported={props.onImported} />)
  })

  return container
}

/**
 * Open the dropdown by firing the captured onOpenChange callback, wait for the
 * detectImportBrowsers promise to resolve and React to re-render.
 */
async function openDropdown(): Promise<void> {
  await act(async () => {
    dropdownCallbacks.onOpenChange?.(true)
  })
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function singleProfileBrowser(): DetectedImportBrowser {
  return {
    family: 'chrome',
    label: 'Google Chrome',
    profiles: [{ name: 'Default', directory: 'Default' }],
    selectedProfile: 'Default'
  }
}

function multiProfileBrowser(): DetectedImportBrowser {
  return {
    family: 'chrome',
    label: 'Google Chrome',
    profiles: [
      { name: 'Work', directory: 'Profile 1' },
      { name: 'Personal', directory: 'Profile 2' }
    ],
    selectedProfile: 'Profile 1'
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PasswordImportButton', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    dropdownCallbacks.onOpenChange = undefined
    installWindowApi()
  })

  afterEach(async () => {
    await act(async () => {
      for (const root of mountedRoots.splice(0)) {
        root.unmount()
      }
    })
    document.body.innerHTML = ''
  })

  // -------------------------------------------------------------------------
  // 1. Trigger disabled state
  // -------------------------------------------------------------------------
  describe('when disabled=true', () => {
    it('renders the trigger button as disabled', async () => {
      const container = await renderButton({ disabled: true, onImported: vi.fn() })

      const trigger = container.querySelector<HTMLButtonElement>('[data-testid="import-trigger"]')
      expect(trigger).not.toBeNull()
      expect(trigger?.disabled).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // 2. detect returns [] → disabled "No supported browsers found" item
  // -------------------------------------------------------------------------
  describe('when detectImportBrowsers returns []', () => {
    it('shows a single disabled "No supported browsers found" menu item', async () => {
      apiMocks.detectImportBrowsers.mockResolvedValue([])
      const container = await renderButton()
      await openDropdown()

      const items = container.querySelectorAll<HTMLButtonElement>('[data-testid="menu-item"]')
      expect(items).toHaveLength(1)
      expect(items[0].disabled).toBe(true)
      expect(items[0].textContent).toContain('No supported browsers found')
    })
  })

  // -------------------------------------------------------------------------
  // 3. Single-profile browser → flat menu item, no submenu
  // -------------------------------------------------------------------------
  describe('when detectImportBrowsers returns a single-profile browser', () => {
    it('renders a flat menu item with no submenu wrapper', async () => {
      apiMocks.detectImportBrowsers.mockResolvedValue([singleProfileBrowser()])
      const container = await renderButton()
      await openDropdown()

      const subs = container.querySelectorAll('[data-testid="menu-sub"]')
      expect(subs).toHaveLength(0)

      const items = container.querySelectorAll<HTMLButtonElement>('[data-testid="menu-item"]')
      // One clickable item for the browser; no "no browsers" placeholder.
      expect(items).toHaveLength(1)
      expect(items[0].disabled).toBe(false)
    })

    it('includes the browser label in the menu item text', async () => {
      apiMocks.detectImportBrowsers.mockResolvedValue([singleProfileBrowser()])
      const container = await renderButton()
      await openDropdown()

      const items = container.querySelectorAll<HTMLButtonElement>('[data-testid="menu-item"]')
      expect(items[0].textContent).toContain('Google Chrome')
    })
  })

  // -------------------------------------------------------------------------
  // 4. Multi-profile browser → DropdownMenuSub with one item per profile
  // -------------------------------------------------------------------------
  describe('when detectImportBrowsers returns a multi-profile browser', () => {
    it('renders a submenu wrapper containing one menu item per profile', async () => {
      apiMocks.detectImportBrowsers.mockResolvedValue([multiProfileBrowser()])
      const container = await renderButton()
      await openDropdown()

      const subs = container.querySelectorAll('[data-testid="menu-sub"]')
      expect(subs).toHaveLength(1)

      const items = container.querySelectorAll<HTMLButtonElement>('[data-testid="menu-item"]')
      expect(items).toHaveLength(2)
    })

    it('labels items by profile name', async () => {
      apiMocks.detectImportBrowsers.mockResolvedValue([multiProfileBrowser()])
      const container = await renderButton()
      await openDropdown()

      const items = container.querySelectorAll<HTMLButtonElement>('[data-testid="menu-item"]')
      const labels = Array.from(items).map((el) => el.textContent ?? '')
      expect(labels).toContain('Work')
      expect(labels).toContain('Personal')
    })
  })

  // -------------------------------------------------------------------------
  // 5. Single-profile click → importFromBrowser called with correct args
  // -------------------------------------------------------------------------
  describe('clicking a single-profile item', () => {
    it('calls importFromBrowser with the family and no browserProfile', async () => {
      apiMocks.detectImportBrowsers.mockResolvedValue([singleProfileBrowser()])
      apiMocks.importFromBrowser.mockResolvedValue({
        ok: true,
        browserLabel: 'Google Chrome',
        profileLabel: '',
        added: 5,
        skipped: 0,
        invalid: 0
      })

      const container = await renderButton()
      await openDropdown()

      const item = container.querySelector<HTMLButtonElement>('[data-testid="menu-item"]')!
      await act(async () => {
        item.click()
      })

      expect(apiMocks.importFromBrowser).toHaveBeenCalledWith({
        browserFamily: 'chrome',
        browserProfile: undefined
      })
    })
  })

  // -------------------------------------------------------------------------
  // 6. Multi-profile click → importFromBrowser with profile directory
  // -------------------------------------------------------------------------
  describe('clicking a profile inside a submenu', () => {
    it('calls importFromBrowser with the family and the profile directory', async () => {
      apiMocks.detectImportBrowsers.mockResolvedValue([multiProfileBrowser()])
      apiMocks.importFromBrowser.mockResolvedValue({
        ok: true,
        browserLabel: 'Google Chrome',
        profileLabel: 'Work',
        added: 3,
        skipped: 0,
        invalid: 0
      })

      const container = await renderButton()
      await openDropdown()

      const items = container.querySelectorAll<HTMLButtonElement>('[data-testid="menu-item"]')
      await act(async () => {
        items[0].click() // first profile: Work / Profile 1
      })

      expect(apiMocks.importFromBrowser).toHaveBeenCalledWith({
        browserFamily: 'chrome',
        browserProfile: 'Profile 1'
      })
    })
  })

  // -------------------------------------------------------------------------
  // 7. Successful import → success toast + onImported called
  // -------------------------------------------------------------------------
  describe('on successful import', () => {
    it('fires toast.success and calls onImported once', async () => {
      const onImported = vi.fn()
      apiMocks.detectImportBrowsers.mockResolvedValue([singleProfileBrowser()])
      apiMocks.importFromBrowser.mockResolvedValue({
        ok: true,
        browserLabel: 'Google Chrome',
        profileLabel: '',
        added: 10,
        skipped: 2,
        invalid: 1
      })

      const container = await renderButton({ disabled: false, onImported })
      await openDropdown()

      const item = container.querySelector<HTMLButtonElement>('[data-testid="menu-item"]')!
      await act(async () => {
        item.click()
      })

      expect(toastMocks.success).toHaveBeenCalledOnce()
      expect(toastMocks.error).not.toHaveBeenCalled()
      expect(onImported).toHaveBeenCalledOnce()
    })

    it('calls onImported AFTER the import resolves', async () => {
      const callOrder: string[] = []
      const onImported = vi.fn(() => {
        callOrder.push('onImported')
      })

      let importResolve!: (value: PasswordImportResult) => void
      apiMocks.detectImportBrowsers.mockResolvedValue([singleProfileBrowser()])
      apiMocks.importFromBrowser.mockReturnValue(
        new Promise<PasswordImportResult>((resolve) => {
          importResolve = resolve
        })
      )

      const container = await renderButton({ disabled: false, onImported })
      await openDropdown()

      const item = container.querySelector<HTMLButtonElement>('[data-testid="menu-item"]')!
      // Start the import (don't await — import is pending).
      act(() => {
        item.click()
      })

      // Import hasn't resolved yet.
      expect(onImported).not.toHaveBeenCalled()

      // Now resolve the import.
      callOrder.push('import-resolved')
      await act(async () => {
        importResolve({
          ok: true,
          browserLabel: 'Google Chrome',
          profileLabel: '',
          added: 1,
          skipped: 0,
          invalid: 0
        })
      })

      expect(callOrder.indexOf('import-resolved')).toBeLessThan(callOrder.indexOf('onImported'))
    })
  })

  // -------------------------------------------------------------------------
  // 8. Failed import → error toast with reason, onImported NOT called
  // -------------------------------------------------------------------------
  describe('on failed import', () => {
    it('fires toast.error with the reason string and does not call onImported', async () => {
      const onImported = vi.fn()
      apiMocks.detectImportBrowsers.mockResolvedValue([singleProfileBrowser()])
      apiMocks.importFromBrowser.mockResolvedValue({
        ok: false,
        reason: 'Could not decrypt keychain'
      })

      const container = await renderButton({ disabled: false, onImported })
      await openDropdown()

      const item = container.querySelector<HTMLButtonElement>('[data-testid="menu-item"]')!
      await act(async () => {
        item.click()
      })

      expect(toastMocks.error).toHaveBeenCalledWith('Could not decrypt keychain')
      expect(toastMocks.success).not.toHaveBeenCalled()
      expect(onImported).not.toHaveBeenCalled()
    })
  })
})
