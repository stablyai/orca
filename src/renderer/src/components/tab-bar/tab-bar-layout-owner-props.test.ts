import { beforeEach, describe, expect, it, vi } from 'vitest'
import { withLayoutOwnerTabProps } from './tab-bar-layout-owner-props'

const mocks = vi.hoisted(
  (): {
    callRuntimeRpc: ReturnType<typeof vi.fn>
    ownerEnvironmentId: string | null
    recordFeatureInteraction: ReturnType<typeof vi.fn>
  } => ({ callRuntimeRpc: vi.fn(), ownerEnvironmentId: null, recordFeatureInteraction: vi.fn() })
)

vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.callRuntimeRpc }))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      unifiedTabsByWorktree: {},
      recordFeatureInteraction: mocks.recordFeatureInteraction
    })
  }
}))
vi.mock('@/lib/resolve-owner', () => ({
  runtimeEnvironmentIdUnlessTwin: () => mocks.ownerEnvironmentId
}))

const pinnedItem = { unifiedTabId: 'tab-editor', isPinned: true }

function windowActions() {
  return {
    togglePinned: vi.fn<(item: typeof pinnedItem) => void>(),
    makePreviewFilePermanent: vi.fn<(fileId: string, tabId?: string) => void>()
  }
}

function wrap(today: ReturnType<typeof windowActions>) {
  return withLayoutOwnerTabProps(today, () => 'wt-1')
}

describe('withLayoutOwnerTabProps', () => {
  beforeEach(() => {
    mocks.callRuntimeRpc.mockReset()
    mocks.ownerEnvironmentId = null
    mocks.recordFeatureInteraction.mockReset()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('sends the pin to main by tab-bar id and leaves drawing it to main’s frame', async () => {
    mocks.callRuntimeRpc.mockResolvedValue({ ok: true, result: {} })
    const today = windowActions()

    wrap(today).togglePinned(pinnedItem)

    expect(mocks.callRuntimeRpc.mock.calls.map((call) => call[2])).toEqual([
      { command: { type: 'setTabProps', tabId: 'tab-editor', isPinned: false, workspace: 'wt-1' } }
    ])
    await vi.waitFor(() =>
      expect(mocks.recordFeatureInteraction).toHaveBeenCalledWith('terminal-tabs')
    )
    expect(today.togglePinned).not.toHaveBeenCalled()
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
