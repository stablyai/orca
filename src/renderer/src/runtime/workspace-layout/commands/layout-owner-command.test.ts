import {
  _resetLayoutOwnerPaneTreeHoldsForTests,
  isTabPaneTreeHeld
} from '../intents/layout-owner-pane-tree-holds'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../server/server-layout-apply-routes'
import { endLayoutFramePositions, noteLayoutFramePosition } from '../frames/layout-frame-position'
import { sendLayoutCommandToOwner } from './layout-owner-command'
import { _resetLayoutOwnerPaneIntentsForTests } from '../intents/layout-owner-pane-intents'

const mocks = vi.hoisted(
  (): {
    callRuntimeRpc: ReturnType<typeof vi.fn>
    ownerEnvironmentId: string | null
  } => ({
    callRuntimeRpc: vi.fn(),
    ownerEnvironmentId: null
  })
)

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: mocks.callRuntimeRpc
}))
vi.mock('@/store/index', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('@/lib/workspace/ownership/resolve-owner', () => ({
  runtimeEnvironmentIdUnlessTwin: () => mocks.ownerEnvironmentId,
  runtimeEnvironmentIdForWorkspaceOwner: () => ({
    kind: 'resolved',
    environmentId: mocks.ownerEnvironmentId
  })
}))

const SPLIT = {
  type: 'splitPane',
  tabId: 'tab-1',
  leafId: 'leaf-1',
  direction: 'vertical'
} as const

function handlers() {
  return { apply: vi.fn(), asToday: vi.fn(), refused: vi.fn() }
}

describe('sendLayoutCommandToOwner', () => {
  afterEach(() => {
    endLayoutFramePositions()
    _resetLayoutOwnerPaneIntentsForTests()
    _resetLayoutOwnerPaneTreeHoldsForTests()
  })

  beforeEach(() => {
    mocks.callRuntimeRpc.mockReset()
    mocks.ownerEnvironmentId = null
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('keeps the tab’s drawn tree from frames until its answer, and what awaits it, has run', async () => {
    noteLayoutFramePosition(4)
    mocks.callRuntimeRpc.mockResolvedValue({ ok: true, result: {}, frameSeq: 5 })
    const on = handlers()
    const heldInCaller = Promise.withResolvers<boolean>()
    on.apply.mockImplementation(() => {
      void Promise.resolve()
        .then(() => undefined)
        .then(() => heldInCaller.resolve(isTabPaneTreeHeld('tab-1')))
      throw new Error('handler failed')
    })

    sendLayoutCommandToOwner('worktree-1', SPLIT, on)
    expect(isTabPaneTreeHeld('tab-1')).toBe(true)
    await vi.waitFor(() => expect(mocks.callRuntimeRpc).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(isTabPaneTreeHeld('tab-1')).toBe(true)

    noteLayoutFramePosition(5)
    expect(on.apply).toHaveBeenCalledOnce()
    await expect(heldInCaller.promise).resolves.toBe(true)
    await vi.waitFor(() => expect(isTabPaneTreeHeld('tab-1')).toBe(false))
  })
})
