// @vitest-environment happy-dom

// Focused regression tests for the five robustness fixes in the Passwords
// settings UI.  Modeled on PasswordImportButton.test.tsx / VoicePane.test.tsx:
// createRoot + act, window.api mocked, component-UI mocks.

import { type ReactNode } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  BrowserCredentialEntry,
  BrowserCredentialVaultStatus
} from '../../../../shared/browser-credential-types'
import type { GlobalSettings } from '../../../../shared/types'

// ---------------------------------------------------------------------------
// Mocks — must be hoisted above all imports that resolve through them
// ---------------------------------------------------------------------------

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('../ui/button', () => ({
  Button: ({
    children,
    disabled,
    onClick,
    ...rest
  }: {
    children: ReactNode
    disabled?: boolean
    onClick?: () => void
    [key: string]: unknown
  }) => (
    <button disabled={disabled} onClick={onClick} {...rest}>
      {children}
    </button>
  )
}))

vi.mock('../ui/input', () => ({
  Input: ({
    value,
    onChange,
    disabled,
    type,
    placeholder
  }: {
    value: string
    onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void
    disabled?: boolean
    type?: string
    placeholder?: string
  }) => (
    <input
      value={value}
      onChange={onChange}
      disabled={disabled}
      type={type}
      placeholder={placeholder}
    />
  )
}))

vi.mock('../ui/label', () => ({
  Label: ({ children, htmlFor }: { children: ReactNode; htmlFor?: string }) => (
    <label htmlFor={htmlFor}>{children}</label>
  )
}))

// Why: useMountedRef must return a stable ref object — a fresh {current:true}
// each render causes useCallback deps to change on every render, infinite loop.
vi.mock('@/hooks/useMountedRef', () => {
  // Stable ref shared across all renders within a test
  const stableRef = { current: true }
  return { useMountedRef: () => stableRef }
})

vi.mock('@/components/confirmation-dialog', () => ({
  useConfirmationDialog: () => vi.fn().mockResolvedValue(true)
}))

// Mock heavy sub-components of PasswordsPane so the tests focus on control
// flow only, not on rendering unrelated settings controls.
vi.mock('./SearchableSetting', () => ({
  SearchableSetting: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('./SettingsFormControls', () => ({
  SettingsSubsectionHeader: () => null,
  SettingsSwitchRow: () => null
}))

vi.mock('./PasswordImportButton', () => ({
  PasswordImportButton: () => null
}))

vi.mock('./passwords-search', () => ({
  getPasswordsPaneSearchEntries: () => []
}))

// ---------------------------------------------------------------------------
// Import components AFTER all vi.mock calls
// ---------------------------------------------------------------------------

import { PasswordRow } from './PasswordRow'
import { AddPasswordForm } from './AddPasswordForm'
import { PasswordsPane } from './PasswordsPane'

// ---------------------------------------------------------------------------
// window.api helpers
// ---------------------------------------------------------------------------

const credentialsMock = {
  status: vi.fn<() => Promise<BrowserCredentialVaultStatus>>(),
  list: vi.fn<() => Promise<BrowserCredentialEntry[]>>(),
  add: vi.fn<
    (args: {
      origin: string
      username: string
      password: string
    }) => Promise<BrowserCredentialEntry | null>
  >(),
  update:
    vi.fn<
      (args: {
        id: string
        username?: string
        password?: string
      }) => Promise<BrowserCredentialEntry | null>
    >(),
  reveal: vi.fn<(id: string) => Promise<string | null>>()
}

function installWindowApi(): void {
  Object.assign(window, {
    api: {
      browser: {
        credentials: credentialsMock
      }
    }
  })
}

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------

const mountedRoots: Root[] = []

async function mount(node: React.ReactNode): Promise<HTMLDivElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mountedRoots.push(root)
  await act(async () => {
    root.render(node)
  })
  return container
}

function makeEntry(overrides: Partial<BrowserCredentialEntry> = {}): BrowserCredentialEntry {
  return {
    id: 'test-id',
    origin: 'https://example.com',
    hostname: 'example.com',
    username: 'user@example.com',
    createdAt: 0,
    updatedAt: 0,
    lastUsedAt: null,
    ...overrides
  }
}

function makeSettings() {
  return {
    browserPasswordAutofillEnabled: true
  } as GlobalSettings
}

// Fire a synthetic React-compatible change event on an input.
function fireChange(input: HTMLInputElement, value: string): void {
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value'
  )?.set
  nativeInputValueSetter?.call(input, value)
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
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

// ===========================================================================
// Fix 1 — PasswordRow: failed reveal keeps row masked (bullets shown)
// ===========================================================================

describe('PasswordRow — Fix 1: reveal failure keeps row masked', () => {
  it('keeps bullets when onReveal returns null', async () => {
    const onReveal = vi.fn<(id: string) => Promise<string | null>>().mockResolvedValue(null)
    const container = await mount(
      <PasswordRow entry={makeEntry()} onReveal={onReveal} onUpdate={vi.fn()} onDelete={vi.fn()} />
    )

    const revealBtn = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Reveal password"]'
    )!
    await act(async () => {
      revealBtn.click()
    })

    const passwordDisplay = container.querySelector('.font-mono')
    expect(passwordDisplay?.textContent).toBe('••••••••')
  })

  it('shows plaintext when onReveal returns a non-null value', async () => {
    const onReveal = vi.fn<(id: string) => Promise<string | null>>().mockResolvedValue('s3cr3t!')
    const container = await mount(
      <PasswordRow entry={makeEntry()} onReveal={onReveal} onUpdate={vi.fn()} onDelete={vi.fn()} />
    )

    const revealBtn = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Reveal password"]'
    )!
    await act(async () => {
      revealBtn.click()
    })

    const passwordDisplay = container.querySelector('.font-mono')
    expect(passwordDisplay?.textContent).toBe('s3cr3t!')
  })
})

// ===========================================================================
// Fix 2 — PasswordRow: failed update keeps edit mode open
// ===========================================================================

describe('PasswordRow — Fix 2: failed update keeps edit mode open', () => {
  it('stays in edit mode when onUpdate returns null', async () => {
    const onUpdate = vi
      .fn<(id: string, u: string, p: string) => Promise<BrowserCredentialEntry | null>>()
      .mockResolvedValue(null)

    const container = await mount(
      <PasswordRow entry={makeEntry()} onReveal={vi.fn()} onUpdate={onUpdate} onDelete={vi.fn()} />
    )

    // Enter edit mode
    const editBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Edit login"]')!
    await act(async () => {
      editBtn.click()
    })

    // Click save
    const saveBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Save'
    )!
    await act(async () => {
      saveBtn.click()
    })

    // Edit-mode inputs should still be present
    const inputs = container.querySelectorAll('input')
    expect(inputs.length).toBeGreaterThan(0)
  })

  it('exits edit mode when onUpdate returns a value', async () => {
    const onUpdate = vi
      .fn<(id: string, u: string, p: string) => Promise<BrowserCredentialEntry | null>>()
      .mockResolvedValue(makeEntry())

    const container = await mount(
      <PasswordRow entry={makeEntry()} onReveal={vi.fn()} onUpdate={onUpdate} onDelete={vi.fn()} />
    )

    const editBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Edit login"]')!
    await act(async () => {
      editBtn.click()
    })

    const saveBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Save'
    )!
    await act(async () => {
      saveBtn.click()
    })

    // Inputs should be gone — edit mode exited
    const inputs = container.querySelectorAll('input')
    expect(inputs.length).toBe(0)
  })
})

// ===========================================================================
// Fix 3 — AddPasswordForm: failed add preserves form input
// ===========================================================================

describe('AddPasswordForm — Fix 3: failed add preserves form input', () => {
  async function renderAndFill(
    onAdd: (o: string, u: string, p: string) => Promise<BrowserCredentialEntry | null>,
    onAdded = vi.fn()
  ): Promise<{ container: HTMLDivElement; onAdded: ReturnType<typeof vi.fn> }> {
    const container = await mount(
      <AddPasswordForm disabled={false} onAdd={onAdd} onAdded={onAdded} />
    )

    const [originInput, usernameInput, passwordInput] = Array.from(
      container.querySelectorAll<HTMLInputElement>('input')
    )

    await act(async () => {
      fireChange(originInput, 'https://example.com')
      fireChange(usernameInput, 'me@example.com')
      fireChange(passwordInput, 'hunter2')
    })

    const submitBtn = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent?.includes('Save Login')
    )!
    await act(async () => {
      submitBtn.click()
    })

    return { container, onAdded }
  }

  it('does not call onAdded when onAdd returns null', async () => {
    const onAdd = vi.fn().mockResolvedValue(null)
    const onAdded = vi.fn()
    await renderAndFill(onAdd, onAdded)
    expect(onAdded).not.toHaveBeenCalled()
  })

  it('calls onAdded when onAdd returns an entry', async () => {
    const onAdd = vi.fn().mockResolvedValue(makeEntry())
    const onAdded = vi.fn()
    await renderAndFill(onAdd, onAdded)
    expect(onAdded).toHaveBeenCalledOnce()
  })
})

// ===========================================================================
// Fix 4 — PasswordsPane: status() rejection sets vault unavailable (fail closed)
// ===========================================================================

describe('PasswordsPane — Fix 4: status() rejection disables controls', () => {
  it('shows vault-unavailable warning when status() rejects', async () => {
    credentialsMock.status.mockRejectedValue(new Error('IPC error'))
    credentialsMock.list.mockResolvedValue([])

    const container = await mount(
      <PasswordsPane settings={makeSettings()} updateSettings={vi.fn()} />
    )

    // Flush the rejected promise through the event loop
    await act(async () => {
      await Promise.resolve()
    })

    expect(container.textContent).toContain('Secure storage unavailable')
  })

  it('does NOT show the warning when status() resolves available', async () => {
    credentialsMock.status.mockResolvedValue({ available: true })
    credentialsMock.list.mockResolvedValue([])

    const container = await mount(
      <PasswordsPane settings={makeSettings()} updateSettings={vi.fn()} />
    )

    await act(async () => {
      await Promise.resolve()
    })

    expect(container.textContent).not.toContain('Secure storage unavailable')
  })
})

// ===========================================================================
// Fix 5 — PasswordsPane: loadEntries() clears loadingEntries on rejection
// ===========================================================================

describe('PasswordsPane — Fix 5: list() rejection clears loadingEntries', () => {
  it('does not stay stuck in loading state when list() rejects', async () => {
    credentialsMock.status.mockResolvedValue({ available: true })
    credentialsMock.list.mockRejectedValue(new Error('IPC list error'))

    const container = await mount(
      <PasswordsPane settings={makeSettings()} updateSettings={vi.fn()} />
    )

    // Flush microtasks for the rejected promise chain (then + catch + finally)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    // Loading text should be gone; empty-list message should appear
    expect(container.textContent).not.toContain('Loading')
    expect(container.textContent).toContain('No saved logins yet.')
  })
})
