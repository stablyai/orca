// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { TerminalServiceRetryNotice } from './TerminalServiceRetryNotice'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
const container = document.createElement('div')
const root = createRoot(container)
afterEach(async () => {
  await act(async () => root.render(null))
})

it('keeps retries nondestructive and disables the action until settlement', async () => {
  let finish!: (value: { success: boolean }) => void
  const retry = vi.fn(
    () =>
      new Promise<{ success: boolean }>((resolve) => {
        finish = resolve
      })
  )
  const restart = vi.fn()
  Object.assign(window, { api: { pty: { management: { retry, restart } } } })
  const recovered = vi.fn()
  await act(async () => root.render(<TerminalServiceRetryNotice onRecovered={recovered} />))
  const button = container.querySelector('button')!
  await act(async () => button.click())
  expect(button.disabled).toBe(true)
  expect(retry).toHaveBeenCalledOnce()
  expect(restart).not.toHaveBeenCalled()
  await act(async () => finish({ success: true }))
  expect(recovered).toHaveBeenCalledOnce()
  expect(button.disabled).toBe(false)
})

it('retains an inline error and permits another attempt', async () => {
  const retry = vi.fn(async () => ({ success: false }))
  Object.assign(window, { api: { pty: { management: { retry } } } })
  const recovered = vi.fn()
  await act(async () => root.render(<TerminalServiceRetryNotice onRecovered={recovered} />))
  await act(async () => container.querySelector('button')!.click())
  expect(container.textContent).toContain('still unavailable')
  expect(container.querySelector('button')!.disabled).toBe(false)
  expect(recovered).not.toHaveBeenCalled()
})
