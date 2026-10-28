// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
    value: { browserPasswords: { fillLogin: fill } }
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
  it.each(['Enter', ' '] as const)('moves through accounts and fills with %s', async (key) => {
    if (!focusedField) {
      throw new Error('missing field')
    }
    focusedField.keyboardSelection = true
    render(dropdown())
    await act(async () => {})
    const picker = screen.getByRole('combobox')
    expect(document.activeElement).toBe(picker)
    fireEvent.keyDown(picker, { key: 'ArrowDown' })
    const bob = screen.getByRole('option', { name: 'bob' })
    await waitFor(() => expect(bob.getAttribute('aria-selected')).toBe('true'))
    fireEvent.keyDown(picker, { key })
    expect(fill).toHaveBeenCalledWith({
      browserPageId: 'page',
      fieldToken: 'field',
      entryId: 'bob'
    })
  })

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

  it('dismisses with Escape and keeps portals out of inactive panes', async () => {
    const view = render(dropdown(false))
    expect(screen.queryByText('ada')).toBeNull()
    view.rerender(dropdown())
    await act(async () => {})
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' })
    expect(clear).toHaveBeenCalledWith('page')
    view.rerender(dropdown(false))
    expect(screen.queryByRole('listbox')).toBeNull()
  })
})
