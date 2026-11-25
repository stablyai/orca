// @vitest-environment happy-dom
import { act } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { i18n } from '@/i18n/i18n'
import type { BrowserExtensionWebStoreInstallResult } from '../../../../../../shared/browser/extensions/browser-extension-webstore'
import { BrowserExtensionsWebStoreInstall } from './BrowserExtensionsWebStoreInstall'

const toastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { error: toastError, success: vi.fn() } }))
vi.mock('@/store/index', () => ({ useAppStore: () => vi.fn() }))

const installFromWebStore = vi.fn<() => Promise<BrowserExtensionWebStoreInstallResult>>()

beforeAll(() => {
  i18n.addResourceBundle(
    'xx',
    'translation',
    {
      settings: {
        browser: { extensions: { failure: { alreadyAdded: 'xx: «{{name}}» ya está' } } }
      }
    },
    false,
    true
  )
})

afterAll(() => {
  i18n.removeResourceBundle('xx', 'translation')
})

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('api', { browser: { extensionsInstallFromWebStore: installFromWebStore } })
  await i18n.changeLanguage('xx')
})

afterEach(async () => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  await i18n.changeLanguage('en')
})

async function submit(): Promise<void> {
  render(
    <BrowserExtensionsWebStoreInstall profileId="default" disabled={false} onFinished={vi.fn()} />
  )
  const user = userEvent.setup()
  const input = screen.getByRole('textbox')
  expect((input as HTMLInputElement).disabled).toBe(false)
  await act(async () => user.type(input, 'a'.repeat(32)))
  await act(async () => user.keyboard('{Enter}'))
}

it('words an app-owned failure in the UI language, name included', async () => {
  installFromWebStore.mockResolvedValue({
    status: 'failed',
    error: 'RAW-ENGLISH-added',
    failure: { reason: 'already-added', name: 'Foo: Bar' }
  })
  await submit()
  expect(installFromWebStore).toHaveBeenCalledTimes(1)
  expect(toastError).toHaveBeenCalledWith('xx: «Foo: Bar» ya está')
  expect(toastError).not.toHaveBeenCalledWith('RAW-ENGLISH-added')
})

it('shows an untagged failure, such as rejected input, exactly as main reported it', async () => {
  installFromWebStore.mockResolvedValue({ status: 'failed', error: 'Not allowed' })
  await submit()
  expect(toastError).toHaveBeenCalledWith('Not allowed')
})
