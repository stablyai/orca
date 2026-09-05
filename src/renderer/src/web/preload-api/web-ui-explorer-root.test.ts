// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'
import { getDefaultUIState } from '../../../../shared/constants'
import { createWebUiApi } from './web-ui-api'

const runtime = vi.hoisted(() => ({ call: vi.fn(), id: 'old' }))
vi.mock('./web-runtime-calls', () => ({ callRuntimeResult: runtime.call }))
vi.mock('./web-runtime-session', () => ({
  webRuntimeState: { activeEnvironment: null },
  requireActiveEnvironmentOrNull: () => ({ id: runtime.id })
}))
beforeEach(() => {
  localStorage.clear()
  runtime.call.mockReset()
  runtime.id = 'old'
})

it('keeps explorer preferences local when an old host rejects unknown keys', async () => {
  const ui = createWebUiApi()
  const { explorerDisplayRootByWorktree: _unused, ...oldUI } = getDefaultUIState()
  runtime.call.mockResolvedValue({ ui: oldUI })
  await ui.get()
  await ui.setWithAck!({ explorerDisplayRootByWorktree: { wt: 'src' }, sidebarWidth: 300 })
  expect(runtime.call).toHaveBeenLastCalledWith('ui.set', { sidebarWidth: 300 }, 15000)
  expect((await ui.get()).explorerDisplayRootByWorktree).toEqual({ wt: 'src' })
})

it('sends roots only to the host that advertised the field', async () => {
  const ui = createWebUiApi()
  runtime.id = 'new'
  runtime.call.mockResolvedValue({ ui: getDefaultUIState() })
  await ui.get()
  await ui.setWithAck!({ explorerDisplayRootByWorktree: { wt: '/' } })
  expect(runtime.call).toHaveBeenLastCalledWith(
    'ui.set',
    { explorerDisplayRootByWorktree: { wt: '/' } },
    15000
  )
  runtime.id = 'old'
  await ui.setWithAck!({ explorerDisplayRootByWorktree: { wt: 'src' }, sidebarWidth: 300 })
  expect(runtime.call).toHaveBeenLastCalledWith('ui.set', { sidebarWidth: 300 }, 15000)
})
