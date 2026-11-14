// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'
import { createWebUiApi } from './web-ui-api'

const runtime = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('./web-runtime-calls', () => ({ callRuntimeResult: runtime.call }))
vi.mock('./web-runtime-session', () => ({
  webRuntimeState: { activeEnvironment: null },
  requireActiveEnvironmentOrNull: () => ({ id: 'host' })
}))

beforeEach(() => {
  localStorage.clear()
  runtime.call.mockReset()
})

it('opens the right sidebar when the host cannot answer, and keeps a later close', async () => {
  runtime.call.mockRejectedValue(new Error('host unavailable'))
  const ui = createWebUiApi()

  expect((await ui.get()).rightSidebarOpen).toBe(true)

  await ui.set({ rightSidebarOpen: false })
  expect((await ui.get()).rightSidebarOpen).toBe(false)
})
