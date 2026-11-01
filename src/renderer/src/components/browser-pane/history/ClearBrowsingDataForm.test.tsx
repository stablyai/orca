// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ClearBrowsingDataForm } from './ClearBrowsingDataForm'

const registry = vi.hoisted(
  () => new Map<string, { getAttribute: (name: string) => string | null }>()
)
vi.mock('../host-guest/webview-registry', () => ({ webviewRegistry: registry }))
afterEach(() => {
  cleanup()
  registry.clear()
})
function seedGuest() {
  registry.set('page', { getAttribute: () => 'persist:test' })
}
it('requires a choice and clears only selected categories before clearing scoped history', async () => {
  seedGuest()
  const clearBrowsingData = vi.fn().mockResolvedValue('persist:test')
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { browser: { clearBrowsingData } }
  })
  const history = vi.fn()
  const close = vi.fn()
  render(<ClearBrowsingDataForm pageId="page" onClearHistory={history} onClose={close} />)
  expect(screen.getByRole('button', { name: 'Clear data' }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('checkbox', { name: 'Browsing history' }))
  fireEvent.click(screen.getByRole('button', { name: 'Clear data' }))
  await waitFor(() => expect(close).toHaveBeenCalledOnce())
  expect(clearBrowsingData).toHaveBeenCalledWith({
    browserPageId: 'page',
    partition: 'persist:test',
    cookies: false,
    cache: false
  })
  expect(history).toHaveBeenCalledWith('persist:test')
})
it('keeps the form open on failure and does not clear history', async () => {
  seedGuest()
  const clearBrowsingData = vi.fn().mockRejectedValue(new Error('unavailable'))
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { browser: { clearBrowsingData } }
  })
  const history = vi.fn()
  const close = vi.fn()
  render(<ClearBrowsingDataForm pageId="page" onClearHistory={history} onClose={close} />)
  fireEvent.click(screen.getByRole('checkbox', { name: 'Cookies and site data' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Browsing history' }))
  fireEvent.click(screen.getByRole('button', { name: 'Clear data' }))
  await screen.findByRole('alert')
  expect(history).not.toHaveBeenCalled()
  expect(close).not.toHaveBeenCalled()
})
