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
  await expect(
    ui.setWithAck!({ explorerDisplayRootByWorktree: { wt: 'src' }, sidebarWidth: 300 })
  ).rejects.toThrow('pending host support')
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
  await expect(
    ui.setWithAck!({ explorerDisplayRootByWorktree: { wt: 'src' }, sidebarWidth: 300 })
  ).rejects.toThrow('pending host support')
  expect(runtime.call).toHaveBeenLastCalledWith('ui.set', { sidebarWidth: 300 }, 15000)
})

it('replays unacknowledged preferences after reload and host upgrade', async () => {
  let ui = createWebUiApi()
  const { explorerDisplayRootByWorktree: _unused, ...oldUI } = getDefaultUIState()
  runtime.call.mockResolvedValue({ ui: oldUI })
  await ui.get()
  await expect(ui.setWithAck!({ explorerDisplayRootByWorktree: { wt: 'src' } })).rejects.toThrow()
  expect((await ui.get()).explorerDisplayRootByWorktree).toEqual({ wt: 'src' })
  ui = createWebUiApi()
  runtime.call.mockResolvedValue({ ui: getDefaultUIState() })
  expect((await ui.get()).explorerDisplayRootByWorktree).toEqual({ wt: 'src' })
  expect(runtime.call).toHaveBeenLastCalledWith(
    'ui.set',
    { explorerDisplayRootByWorktree: { wt: 'src' } },
    15000
  )
  runtime.call.mockClear().mockResolvedValue({ ui: getDefaultUIState() })
  await ui.get()
  expect(runtime.call).toHaveBeenCalledTimes(1)
})

it('isolates queued preferences by host and retries a failed replay', async () => {
  const ui = createWebUiApi()
  runtime.call.mockResolvedValue({})
  await expect(ui.setWithAck!({ explorerDisplayRootByWorktree: { wt: 'src' } })).rejects.toThrow()
  runtime.id = 'another'
  runtime.call.mockClear().mockResolvedValue({ ui: getDefaultUIState() })
  await ui.get()
  expect(runtime.call).toHaveBeenCalledTimes(1)
  runtime.id = 'old'
  runtime.call
    .mockResolvedValueOnce({ ui: getDefaultUIState() })
    .mockRejectedValueOnce(new Error('Offline'))
  await ui.get()
  runtime.call.mockClear().mockResolvedValue({ ui: getDefaultUIState() })
  await ui.get()
  expect(runtime.call).toHaveBeenLastCalledWith(
    'ui.set',
    { explorerDisplayRootByWorktree: { wt: 'src' } },
    15000
  )
})

it.each([true, false])(
  'preserves a newer preference during replay (write succeeds: %j)',
  async (succeeds) => {
    const ui = createWebUiApi()
    runtime.call.mockResolvedValue({})
    await expect(
      ui.setWithAck!({ explorerDisplayRootByWorktree: { wt: 'first' } })
    ).rejects.toThrow()
    let finish!: () => void
    runtime.call.mockResolvedValueOnce({ ui: getDefaultUIState() }).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    const reading = ui.get()
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    runtime.call.mockImplementationOnce(() =>
      succeeds ? Promise.resolve({}) : Promise.reject(new Error('Offline'))
    )
    const writing = ui.setWithAck!({ explorerDisplayRootByWorktree: { wt: 'second' } })
    if (succeeds) {
      await writing
    } else {
      await expect(writing).rejects.toThrow('Offline')
    }
    finish()
    expect((await reading).explorerDisplayRootByWorktree).toEqual({ wt: 'second' })
    runtime.call.mockClear().mockResolvedValue({ ui: getDefaultUIState() })
    await ui.get()
    if (succeeds) {
      expect(runtime.call).toHaveBeenCalledTimes(1)
    } else {
      expect(runtime.call).toHaveBeenLastCalledWith(
        'ui.set',
        { explorerDisplayRootByWorktree: { wt: 'second' } },
        15000
      )
    }
  }
)

it('does not replay to a different host when the active host changes during ui.get', async () => {
  const ui = createWebUiApi()
  runtime.call.mockResolvedValue({})
  await expect(ui.setWithAck!({ explorerDisplayRootByWorktree: { wt: 'src' } })).rejects.toThrow()
  let finish!: (value: unknown) => void
  runtime.call.mockClear().mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const reading = ui.get()
  runtime.id = 'another'
  finish({ ui: getDefaultUIState() })
  await reading
  expect(runtime.call).toHaveBeenCalledTimes(1)
})
