// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserPasswordFieldFocusEvent } from '../../../../../shared/browser-passwords-types'
import type * as BrowserPasswordPageStore from './browser-password-page-store'
import { BrowserPasswordFillDropdown } from './BrowserPasswordFillDropdown'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
const { clear, fill } = vi.hoisted(() => ({ clear: vi.fn(), fill: vi.fn() }))
let focusedField: BrowserPasswordFieldFocusEvent | null
vi.mock('./browser-password-page-store', async (importOriginal) => {
  const original = await importOriginal<typeof BrowserPasswordPageStore>()
  return {
    ...original,
    useBrowserPasswordPageState: () => ({ focusedField, focusedFieldShownAt: 0 }),
    clearBrowserPasswordFocusedField: clear
  }
})
const containerRef = { current: document.createElement('div') }
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This DOM fixture exercises only webview geometry and focus.
const webviewRef = { current: document.createElement('webview') as Electron.WebviewTag }

beforeEach(() => {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { browserPasswords: { fillLogin: fill }, browser: { onGuestEscape: () => () => {} } }
  })
  focusedField = {
    browserPageId: 'page',
    fieldToken: 'field',
    role: 'password',
    rect: { x: 0, y: 0, width: 100, height: 20 },
    viewportWidth: 1000,
    suggestions: [
      { entryId: 'ada', origin: 'https://example.com', username: 'ada', exactOrigin: true },
      { entryId: 'bob', origin: 'https://example.com', username: 'bob', exactOrigin: true }
    ]
  }
  clear.mockReset()
  fill.mockReset()
  vi.spyOn(performance, 'now').mockReturnValue(1000)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function dropdown(active = true) {
  return (
    <BrowserPasswordFillDropdown
      browserPageId="page"
      isActive={active}
      containerRef={containerRef}
      webviewRef={webviewRef}
    />
  )
}

describe('saved login selection', () => {
  it('supports assistive click activation and retains the initial fill guard', async () => {
    render(dropdown())
    await act(async () => {})
    const ada = screen.getByText('ada')
    vi.mocked(performance.now).mockReturnValue(100)
    fireEvent.click(ada)
    expect(fill).not.toHaveBeenCalled()
    vi.mocked(performance.now).mockReturnValue(1000)
    fireEvent.click(ada)
    expect(fill).toHaveBeenCalledOnce()
  })
})
