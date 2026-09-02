// @vitest-environment happy-dom

import { beforeEach, expect, it, vi } from 'vitest'

const onSystemResumed = vi.fn()

beforeEach(() => {
  vi.resetModules()
  onSystemResumed.mockReset()
  ;(window as unknown as { api: unknown }).api = { ui: { onSystemResumed } }
})

it('shares one system resume IPC listener across browser pages and releases it', async () => {
  const unsubscribeIpc = vi.fn()
  let dispatchResume: (() => void) | undefined
  onSystemResumed.mockImplementation((listener: () => void) => {
    dispatchResume = listener
    return unsubscribeIpc
  })
  const { subscribeBrowserSystemResume } = await import('./browser-system-resume')
  const first = vi.fn()
  const second = vi.fn()

  const unsubscribeFirst = subscribeBrowserSystemResume(first)
  const unsubscribeSecond = subscribeBrowserSystemResume(second)
  dispatchResume?.()

  expect(onSystemResumed).toHaveBeenCalledOnce()
  expect(first).toHaveBeenCalledOnce()
  expect(second).toHaveBeenCalledOnce()

  unsubscribeFirst()
  expect(unsubscribeIpc).not.toHaveBeenCalled()
  unsubscribeSecond()
  expect(unsubscribeIpc).toHaveBeenCalledOnce()
})

it('continues dispatching when a system resume listener throws', async () => {
  let dispatchResume: (() => void) | undefined
  onSystemResumed.mockImplementation((listener: () => void) => {
    dispatchResume = listener
    return vi.fn()
  })
  const { subscribeBrowserSystemResume } = await import('./browser-system-resume')
  const listenerError = new Error('pane failed')
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  const second = vi.fn()

  subscribeBrowserSystemResume(() => {
    throw listenerError
  })
  subscribeBrowserSystemResume(second)
  dispatchResume?.()

  expect(consoleError).toHaveBeenCalledWith(
    '[browser] system resume listener failed:',
    listenerError
  )
  expect(second).toHaveBeenCalledOnce()
})
