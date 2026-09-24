// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STATUS_BAR_CURSOR_ITEM_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'

const runtime = vi.hoisted(() => ({
  capabilities: [] as string[],
  callRuntimeResult: vi.fn(),
  getRemoteRuntimeStatus: vi.fn()
}))

vi.mock('./web-runtime-calls', () => ({
  callRuntimeResult: runtime.callRuntimeResult,
  getRemoteRuntimeStatus: runtime.getRemoteRuntimeStatus
}))

import { createWebUiApi } from './web-ui-api'

describe('web ui.set host compatibility', () => {
  beforeEach(() => {
    window.localStorage.clear()
    runtime.capabilities = []
    runtime.callRuntimeResult.mockResolvedValue({})
    runtime.getRemoteRuntimeStatus.mockImplementation(() =>
      Promise.resolve({ capabilities: runtime.capabilities })
    )
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('removes Cursor from status-bar items sent to an older host', async () => {
    await createWebUiApi().set?.({ statusBarItems: ['claude', 'cursor', 'ports'] })

    expect(runtime.callRuntimeResult).toHaveBeenCalledWith(
      'ui.set',
      { statusBarItems: ['claude', 'ports'] },
      15_000
    )
  })

  it('preserves Cursor when the host advertises the status-bar item', async () => {
    runtime.capabilities = [STATUS_BAR_CURSOR_ITEM_RUNTIME_CAPABILITY]

    await createWebUiApi().set?.({ statusBarItems: ['claude', 'cursor'] })

    expect(runtime.callRuntimeResult).toHaveBeenCalledWith(
      'ui.set',
      { statusBarItems: ['claude', 'cursor'] },
      15_000
    )
  })

  it('does not probe capabilities for unrelated UI updates', async () => {
    await createWebUiApi().set?.({ statusBarVisible: false })

    expect(runtime.getRemoteRuntimeStatus).not.toHaveBeenCalled()
    expect(runtime.callRuntimeResult).toHaveBeenCalledWith(
      'ui.set',
      { statusBarVisible: false },
      15_000
    )
  })
})
