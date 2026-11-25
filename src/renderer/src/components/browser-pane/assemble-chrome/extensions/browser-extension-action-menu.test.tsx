// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { i18n } from '@/i18n/i18n'
import { ConfirmationDialogProvider } from '@/components/dismiss/confirmation/confirmation-dialog'
import type { BrowserExtensionActionResult } from '../../../../../../shared/browser/extensions/browser-extension-types'
import type { BrowserExtensionToolbarAction } from '../../../../../../shared/browser/extensions/browser-extension-toolbar-types'
import {
  type BrowserExtensionMenuEntry,
  useBrowserExtensionActionMenuEntries
} from './browser-extension-action-menu'

const toastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { error: toastError } }))

const ACTION: BrowserExtensionToolbarAction = {
  extensionId: 'a'.repeat(32),
  name: 'Sample',
  title: 'Sample',
  iconDataUrl: null,
  badgeText: '',
  badgeBackgroundColor: null,
  badgeTextColor: null,
  enabled: true,
  hasPopup: false,
  pinned: false,
  hasOptionsPage: true,
  source: 'webstore'
}

const openOptions = vi.fn<() => Promise<BrowserExtensionActionResult>>()
const actionContextMenu = vi.fn(() => Promise.resolve(null))

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
    browser: { extensionsOpenOptions: openOptions, extensionsActionContextMenu: actionContextMenu }
  })
  await i18n.changeLanguage('xx')
})

afterEach(async () => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  await i18n.changeLanguage('en')
})

function optionsEntry(entries: BrowserExtensionMenuEntry[]): () => void {
  const entry = entries.find((candidate) => candidate.key === 'options')
  if (!entry || 'separator' in entry) {
    throw new Error('Options entry missing')
  }
  return entry.onSelect
}

it('words an app-owned failure in the UI language, not main’s English', async () => {
  openOptions.mockResolvedValue({
    ok: false,
    error: 'RAW-ENGLISH-support',
    failure: { reason: 'support-disabled' }
  })
  const { result } = renderHook(
    () => useBrowserExtensionActionMenuEntries('default', ACTION, 'page-1'),
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <ConfirmationDialogProvider>{children}</ConfirmationDialogProvider>
      )
    }
  )
  await waitFor(() => expect(actionContextMenu).toHaveBeenCalled())
  await act(async () => optionsEntry(result.current)())
  await waitFor(() => expect(toastError).toHaveBeenCalled())
  expect(openOptions).toHaveBeenCalledWith({
    profileId: 'default',
    extensionId: ACTION.extensionId
  })
  expect(toastError).toHaveBeenCalledWith('xx: turn on')
  expect(toastError).not.toHaveBeenCalledWith('RAW-ENGLISH-support')
})
