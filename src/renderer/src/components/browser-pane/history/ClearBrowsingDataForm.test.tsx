// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ClearBrowsingDataForm } from './ClearBrowsingDataForm'

const registry = vi.hoisted(
  () => new Map<string, { getAttribute: (name: string) => string | null }>()
)
const clientPagePartition = vi.hoisted(() => vi.fn<(pageId: string) => string | null>())
vi.mock('../host-guest/webview-registry', () => ({ webviewRegistry: registry }))
vi.mock('../browser-client-page-renderer-installation', () => ({
  getVisibleBrowserClientPagePartition: clientPagePartition
}))
afterEach(() => {
  cleanup()
  registry.clear()
  clientPagePartition.mockReset()
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
it('clears a client-hosted page using the partition of its retained guest', async () => {
  clientPagePartition.mockImplementation((pageId) =>
    pageId === 'page' ? 'persist:client-hosted' : null
  )
  const clearBrowsingData = vi.fn().mockResolvedValue('persist:client-hosted')
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { browser: { clearBrowsingData } }
  })
  const close = vi.fn()
  render(<ClearBrowsingDataForm pageId="page" onClearHistory={vi.fn()} onClose={close} />)
  fireEvent.click(screen.getByRole('checkbox', { name: 'Cookies and site data' }))
  fireEvent.click(screen.getByRole('button', { name: 'Clear data' }))
  await waitFor(() => expect(close).toHaveBeenCalledOnce())
  expect(clearBrowsingData).toHaveBeenCalledWith({
    browserPageId: 'page',
    partition: 'persist:client-hosted',
    cookies: true,
    cache: false
  })
})
it('submits with Enter from a checkbox only after a choice is selected', async () => {
  seedGuest()
  const clearBrowsingData = vi.fn().mockResolvedValue('persist:test')
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { browser: { clearBrowsingData } }
  })
  const close = vi.fn()
  render(<ClearBrowsingDataForm pageId="page" onClearHistory={vi.fn()} onClose={close} />)
  const cookies = screen.getByRole('checkbox', { name: 'Cookies and site data' })
  fireEvent.keyDown(cookies, { key: 'Enter' })
  expect(clearBrowsingData).not.toHaveBeenCalled()
  fireEvent.click(cookies)
  fireEvent.keyDown(cookies, { key: 'Enter' })
  await waitFor(() => expect(close).toHaveBeenCalledOnce())
  expect(clearBrowsingData).toHaveBeenCalledOnce()
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

it('keeps the clearing dialog open while the request is pending', async () => {
  seedGuest()
  let finish: (partition: string) => void = () => {}
  const clearBrowsingData = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve
      })
  )
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { browser: { clearBrowsingData } }
  })
  const close = vi.fn()
  render(<ClearBrowsingDataForm pageId="page" onClearHistory={vi.fn()} onClose={close} />)
  fireEvent.click(screen.getByRole('checkbox', { name: 'Cookies and site data' }))
  fireEvent.click(screen.getByRole('button', { name: 'Clear data' }))
  expect(screen.getByRole('button', { name: 'Cancel' }).hasAttribute('disabled')).toBe(true)
  expect(screen.queryByRole('button', { name: 'Close' })).toBeNull()
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
  expect(close).not.toHaveBeenCalled()
  expect(screen.getByRole('dialog')).toBeTruthy()
  finish('persist:test')
  await waitFor(() => expect(close).toHaveBeenCalledOnce())
})
