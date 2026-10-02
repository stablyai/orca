// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'
import { getDefaultUIState } from '../../../../shared/constants'
import { createWebUiApi } from './web-ui-api'

const runtime = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('./web-runtime-calls', () => ({ callRuntimeResult: runtime.call }))
vi.mock('./web-runtime-session', () => ({
  webRuntimeState: { activeEnvironment: null },
  requireActiveEnvironmentOrNull: () => ({ id: 'old' })
}))

beforeEach(() => {
  localStorage.clear()
  runtime.call.mockReset()
  runtime.call.mockImplementation(async (method, params) => {
    if (
      method === 'ui.set' &&
      (params.statusBarItems?.includes('synthetic') || '_syntheticStatusBarDefaultAdded' in params)
    ) {
      throw new Error('Old host rejects Synthetic preferences')
    }
    return { ui: { ...getDefaultUIState(), statusBarItems: ['codex'] } }
  })
})

it.each(['set', 'setWithAck'] as const)(
  'keeps Synthetic local in %s while sending unrelated preferences',
  async (method) => {
    const ui = createWebUiApi()
    await ui[method]?.({
      statusBarItems: ['codex', 'synthetic'],
      _syntheticStatusBarDefaultAdded: true,
      sidebarWidth: 300
    })
    expect(runtime.call).toHaveBeenLastCalledWith(
      'ui.set',
      { statusBarItems: ['codex'], sidebarWidth: 300 },
      15_000
    )
    expect(await ui.get()).toMatchObject({
      statusBarItems: ['codex', 'synthetic'],
      _syntheticStatusBarDefaultAdded: true
    })
  }
)

it('preserves a hidden Synthetic meter when hydrating from the host', async () => {
  const ui = createWebUiApi()
  await ui.setWithAck?.({ statusBarItems: ['codex'], _syntheticStatusBarDefaultAdded: true })
  expect(await ui.get()).toMatchObject({
    statusBarItems: ['codex'],
    _syntheticStatusBarDefaultAdded: true
  })
})

it.each([true, false])(
  'preserves Synthetic visibility (%s) after a feature interaction',
  async (visible) => {
    const ui = createWebUiApi()
    const statusBarItems = visible ? (['codex', 'synthetic'] as const) : (['codex'] as const)
    await ui.setWithAck?.({
      statusBarItems: [...statusBarItems],
      _syntheticStatusBarDefaultAdded: true
    })
    const result = await ui.recordFeatureInteraction('usage-tracking')
    expect(result).toMatchObject({
      statusBarItems: [...statusBarItems],
      _syntheticStatusBarDefaultAdded: true
    })
    expect(await ui.get()).toMatchObject({ statusBarItems: [...statusBarItems] })
  }
)
