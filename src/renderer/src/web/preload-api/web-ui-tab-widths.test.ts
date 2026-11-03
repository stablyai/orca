// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'
import { getDefaultUIState } from '../../../../shared/constants'
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

it('merges per-tab width patches into local state when the host is unreachable', async () => {
  const ui = createWebUiApi()
  runtime.call.mockRejectedValue(new Error('offline'))
  await expect(ui.setWithAck!({ tabWidthsById: { a: 400 } })).rejects.toThrow()
  await expect(ui.setWithAck!({ tabWidthsById: { b: 200 } })).rejects.toThrow()
  await expect(ui.setWithAck!({ tabWidthsById: { a: null } })).rejects.toThrow()
  expect((await ui.get()).tabWidthsById).toEqual({ b: 200 })
})

it('takes the host map as-is so widths reset on another client do not come back', async () => {
  const ui = createWebUiApi()
  runtime.call.mockResolvedValue(undefined)
  await ui.setWithAck!({ tabWidthsById: { a: 400, b: 200 } })
  runtime.call.mockResolvedValue({ ui: { ...getDefaultUIState(), tabWidthsById: { b: 250 } } })
  expect((await ui.get()).tabWidthsById).toEqual({ b: 250 })
})
