import { beforeEach, describe, expect, it, vi } from 'vitest'
import { withLayoutOwnerTabProps } from './tab-bar-layout-owner-props'

const mocks = vi.hoisted(
  (): {
    callRuntimeRpc: ReturnType<typeof vi.fn>
    ownerEnvironmentId: string | null
  } => ({ callRuntimeRpc: vi.fn(), ownerEnvironmentId: null })
)

vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.callRuntimeRpc }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('@/lib/resolve-owner', () => ({
  runtimeEnvironmentIdUnlessTwin: () => mocks.ownerEnvironmentId
}))

const pinnedItem = { unifiedTabId: 'tab-editor', isPinned: true }

function windowActions() {
  return { togglePinned: vi.fn<(item: typeof pinnedItem) => void>() }
}

function wrap(today: ReturnType<typeof windowActions>) {
  return withLayoutOwnerTabProps(today, () => 'wt-1')
}

describe('withLayoutOwnerTabProps', () => {
  beforeEach(() => {
    mocks.callRuntimeRpc.mockReset()
    mocks.ownerEnvironmentId = null
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('sends the pin to main by tab-bar id, then the window shows the same change', async () => {
    mocks.callRuntimeRpc.mockResolvedValue({ ok: true, result: {} })
    const today = windowActions()

    wrap(today).togglePinned(pinnedItem)

    expect(mocks.callRuntimeRpc.mock.calls.map((call) => call[2])).toEqual([
      { command: { type: 'setTabProps', tabId: 'tab-editor', isPinned: false, workspace: 'wt-1' } }
    ])
    expect(today.togglePinned).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(today.togglePinned).toHaveBeenCalledWith(pinnedItem))
  })

  it('leaves the window as it is when main refuses', async () => {
    mocks.callRuntimeRpc.mockResolvedValue({ ok: false, code: 'invalid_params' })
    const today = windowActions()

    wrap(today).togglePinned(pinnedItem)

    await vi.waitFor(() => expect(console.warn).toHaveBeenCalled())
    expect(today.togglePinned).not.toHaveBeenCalled()
  })

  it('acts as today at once for a paired server’s workspace', () => {
    mocks.ownerEnvironmentId = 'env-1'
    const today = windowActions()

    wrap(today).togglePinned(pinnedItem)

    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
    expect(today.togglePinned).toHaveBeenCalledWith(pinnedItem)
  })
})
