// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LocalNetworkConnectionTest } from './LocalNetworkConnectionTest'

let container: HTMLDivElement
let root: Root
const testConnectionMock = vi.fn()

beforeEach(() => {
  localStorage.clear()
  testConnectionMock.mockReset()
  Object.assign(window, {
    api: {
      developerPermissions: {
        testLocalNetworkConnection: testConnectionMock
      }
    }
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  localStorage.clear()
  Reflect.deleteProperty(window, 'api')
})

function inputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

async function expandConnectionTest(): Promise<void> {
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-slot="collapsible-trigger"]')?.click()
  )
}

it('keeps the target form collapsed by default', async () => {
  await act(async () => root.render(<LocalNetworkConnectionTest />))

  expect(container.textContent).toContain('Test connection')
  expect(container.textContent).toContain('No successful test saved.')
  expect(container.querySelector('form')).toBeNull()
})

it('saves and displays the last successful target-specific test', async () => {
  testConnectionMock.mockResolvedValue({
    ok: true,
    host: '192.168.1.20',
    port: 3000,
    testedAt: new Date('2026-08-06T07:00:00Z').getTime()
  })
  await act(async () => root.render(<LocalNetworkConnectionTest />))
  await expandConnectionTest()

  const host = container.querySelector<HTMLInputElement>('#local-network-test-host')!
  const port = container.querySelector<HTMLInputElement>('#local-network-test-port')!
  await act(async () => {
    inputValue(host, '192.168.1.20')
    inputValue(port, '3000')
  })
  await act(async () =>
    container.querySelector<HTMLButtonElement>('button[type="submit"]')?.click()
  )

  expect(testConnectionMock).toHaveBeenCalledWith({ host: '192.168.1.20', port: 3000 })
  expect(container.textContent).toContain('Last verified')
  expect(container.textContent).toContain('192.168.1.20:3000')

  await act(async () => root.render(null))
  await act(async () => root.render(<LocalNetworkConnectionTest />))
  await expandConnectionTest()
  expect(container.textContent).toContain('192.168.1.20:3000')
})

it('keeps the last success visible when a later test fails', async () => {
  testConnectionMock
    .mockResolvedValueOnce({
      ok: true,
      host: 'devbox.local',
      port: 8080,
      testedAt: 1000
    })
    .mockResolvedValueOnce({
      ok: false,
      host: 'devbox.local',
      port: 8080,
      testedAt: 2000,
      failure: 'refused'
    })
  await act(async () => root.render(<LocalNetworkConnectionTest />))
  await expandConnectionTest()

  const host = container.querySelector<HTMLInputElement>('#local-network-test-host')!
  const port = container.querySelector<HTMLInputElement>('#local-network-test-port')!
  await act(async () => {
    inputValue(host, 'devbox.local')
    inputValue(port, '8080')
  })
  await act(async () =>
    container.querySelector<HTMLButtonElement>('button[type="submit"]')?.click()
  )
  await act(async () =>
    container.querySelector<HTMLButtonElement>('button[type="submit"]')?.click()
  )

  expect(container.textContent).toContain('Last verified')
  expect(container.textContent).toContain('devbox.local:8080')
  expect(container.textContent).toContain('The host responded, but the port refused')
  expect(container.textContent).not.toContain('Permission denied')
})
