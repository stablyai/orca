// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { i18n } from '@/i18n/i18n'
import { ConfirmationDialogProvider } from '@/components/dismiss/confirmation/confirmation-dialog'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { GlobalSettings } from '../../../../../../shared/settings/global-settings-types'
import type {
  BrowserExtensionActionResult,
  BrowserExtensionListing
} from '../../../../../../shared/browser/extensions/browser-extension-types'
import { BrowserExtensionsSection } from './BrowserExtensionsSection'

const toastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { error: toastError, success: vi.fn() } }))
// Search filtering is the settings page's concern; render the row outside a settings view.
vi.mock('../../section-layout/SearchableSetting', () => ({
  SearchableSetting: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))
// Covered by its own test; stubbed so this one exercises only the section's action toasts.
vi.mock('./BrowserExtensionsWebStoreInstall', () => ({
  BrowserExtensionsWebStoreInstall: () => null
}))

const EXTENSION: BrowserExtensionListing = {
  id: 'a'.repeat(32),
  name: 'Sample',
  version: '1.0.0',
  source: 'webstore',
  path: '/extensions/sample',
  enabled: false,
  iconDataUrl: null,
  hasOptionsPage: false,
  permissions: [],
  loadError: null,
  heldUpdateVersion: null
}

const setEnabled = vi.fn<() => Promise<BrowserExtensionActionResult>>()

beforeAll(() => {
  i18n.addResourceBundle(
    'xx',
    'translation',
    { settings: { browser: { extensions: { failure: { supportDisabled: 'xx: turn on' } } } } },
    false,
    true
  )
})

afterAll(() => {
  i18n.removeResourceBundle('xx', 'translation')
})

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('api', {
    browser: {
      onExtensionsChanged: () => () => {},
      extensionsList: () => Promise.resolve({ active: true, extensions: [EXTENSION] }),
      extensionsSetEnabled: setEnabled
    }
  })
  await i18n.changeLanguage('xx')
})

afterEach(async () => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  await i18n.changeLanguage('en')
})

async function toggleExtension(): Promise<void> {
  render(
    <TooltipProvider>
      <ConfirmationDialogProvider>
        <BrowserExtensionsSection
          profileId="default"
          profileLabel="Default"
          settings={{ browserExtensionsEnabled: true } as GlobalSettings}
          updateSettings={vi.fn()}
        />
      </ConfirmationDialogProvider>
    </TooltipProvider>
  )
  const toggle = await screen.findByRole('switch', { name: /Sample/ })
  expect((toggle as HTMLButtonElement).disabled).toBe(false)
  await act(async () => userEvent.setup().click(toggle))
}

it('words an app-owned failure in the UI language, not main’s English', async () => {
  setEnabled.mockResolvedValue({
    ok: false,
    error: 'RAW-ENGLISH-support',
    failure: { reason: 'support-disabled' }
  })
  await toggleExtension()
  expect(setEnabled).toHaveBeenCalledTimes(1)
  expect(toastError).toHaveBeenCalledWith('xx: turn on')
  expect(toastError).not.toHaveBeenCalledWith('RAW-ENGLISH-support')
})

it('shows an untagged diagnostic exactly as main reported it', async () => {
  setEnabled.mockResolvedValue({ ok: false, error: 'EACCES: permission denied' })
  await toggleExtension()
  expect(toastError).toHaveBeenCalledWith('EACCES: permission denied')
})
