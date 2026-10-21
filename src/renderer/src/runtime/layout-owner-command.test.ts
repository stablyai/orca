import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { endLayoutFramePositions, noteLayoutFramePosition } from './layout-frame-position'
import { sendLayoutCommandToOwner } from './layout-owner-command'
import {
  _resetLayoutOwnerPaneIntentsForTests,
  isTabPaneTreeHeld
} from './layout-owner-pane-intents'

const mocks = vi.hoisted(
  (): {
    callRuntimeRpc: ReturnType<typeof vi.fn>
    ownerEnvironmentId: string | null
  } => ({
    callRuntimeRpc: vi.fn(),
    ownerEnvironmentId: null
  })
)

vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.callRuntimeRpc }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('@/lib/resolve-owner', () => ({
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
  })

  beforeEach(() => {
    mocks.callRuntimeRpc.mockReset()
    mocks.ownerEnvironmentId = null
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('asks local main first, then applies main’s result', async () => {
    mocks.callRuntimeRpc.mockResolvedValue({ ok: true, result: { leafId: 'leaf-minted' } })
    const on = handlers()

    expect(sendLayoutCommandToOwner('worktree-1', SPLIT, on)).toBe(true)

    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith({ kind: 'local' }, 'layout.apply', {
      command: { ...SPLIT, workspace: 'worktree-1' }
    })
    expect(on.apply).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(on.apply).toHaveBeenCalledWith({ leafId: 'leaf-minted' }))
    expect(on.asToday).not.toHaveBeenCalled()
  })

  it('shows main’s result only once the window holds the frame with main’s change', async () => {
    noteLayoutFramePosition(4)
    mocks.callRuntimeRpc.mockResolvedValue({
      ok: true,
      result: { leafId: 'leaf-minted' },
      frameSeq: 5
    })
    const on = handlers()

    sendLayoutCommandToOwner('worktree-1', SPLIT, on)
    await vi.waitFor(() => expect(mocks.callRuntimeRpc).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(on.apply).not.toHaveBeenCalled()

    noteLayoutFramePosition(5)
    expect(on.apply).toHaveBeenCalledWith({ leafId: 'leaf-minted' })
  })

  it('changes nothing itself after a refusal', async () => {
    mocks.callRuntimeRpc.mockResolvedValue({ ok: false, code: 'last_pane' })
    const on = handlers()

    expect(sendLayoutCommandToOwner('worktree-1', SPLIT, on)).toBe(true)

    await vi.waitFor(() => expect(console.warn).toHaveBeenCalled())
    expect(on.apply).not.toHaveBeenCalled()
    expect(on.asToday).not.toHaveBeenCalled()
  })

  it.each([
    [
      'main lacks the pane',
      () => mocks.callRuntimeRpc.mockResolvedValue({ ok: false, code: 'pane_not_found' })
    ],
    [
      'main lacks the tab',
      () => mocks.callRuntimeRpc.mockResolvedValue({ ok: false, code: 'tab_not_found' })
    ],
    [
      'main lacks the workspace',
      () => mocks.callRuntimeRpc.mockResolvedValue({ ok: false, code: 'workspace_not_found' })
    ]
  ])('refuses, logging it and drawing nothing, when %s', async (_case, arrange) => {
    arrange()
    const on = handlers()

    sendLayoutCommandToOwner('worktree-1', SPLIT, on)

    await vi.waitFor(() => expect(on.refused).toHaveBeenCalledOnce())
    expect(on.asToday).not.toHaveBeenCalled()
    expect(console.warn).toHaveBeenCalledWith(
      '[layout-owner] splitPane refused:',
      expect.stringMatching(/_not_found$/)
    )
  })

  it('refuses, drawing nothing, when the call fails', async () => {
    mocks.callRuntimeRpc.mockRejectedValue(new Error('rpc_failed'))
    const on = handlers()

    sendLayoutCommandToOwner('worktree-1', SPLIT, on)

    await vi.waitFor(() => expect(on.refused).toHaveBeenCalledWith('call_failed'))
    expect(on.asToday).not.toHaveBeenCalled()
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

  it('holds no tab for a command that changes no pane tree', async () => {
    mocks.callRuntimeRpc.mockResolvedValue({ ok: true, result: {} })

    sendLayoutCommandToOwner(
      'worktree-1',
      { type: 'renameTab', tabId: 'tab-1', kind: 'custom', title: 'logs' },
      handlers()
    )

    expect(isTabPaneTreeHeld('tab-1')).toBe(false)
  })

  it('does not run the fallback when the caller’s own handler throws', async () => {
    mocks.callRuntimeRpc.mockResolvedValue({ ok: true, result: { leafId: 'leaf-minted' } })
    const on = handlers()
    on.apply.mockImplementation(() => {
      throw new Error('mount failed')
    })

    sendLayoutCommandToOwner('worktree-1', SPLIT, on)

    await vi.waitFor(() => expect(console.warn).toHaveBeenCalled())
    expect(on.asToday).not.toHaveBeenCalled()
  })

  it('hands any other refusal to the caller', async () => {
    mocks.callRuntimeRpc.mockResolvedValue({ ok: false, code: 'last_pane' })
    const on = handlers()

    sendLayoutCommandToOwner('worktree-1', SPLIT, on)

    await vi.waitFor(() => expect(on.refused).toHaveBeenCalledWith('last_pane'))
  })

  it('refuses a workspace main routes to no host of its own, drawing nothing', async () => {
    mocks.callRuntimeRpc.mockResolvedValue({ ok: false, code: 'host_not_owned' })
    const on = handlers()

    expect(sendLayoutCommandToOwner('worktree-1', SPLIT, on)).toBe(true)

    await vi.waitFor(() => expect(on.refused).toHaveBeenCalledWith('host_not_owned'))
    expect(on.asToday).not.toHaveBeenCalled()
    expect(on.apply).not.toHaveBeenCalled()
  })

  it('leaves a paired server’s workspace to today’s path', () => {
    mocks.ownerEnvironmentId = 'env-1'

    expect(sendLayoutCommandToOwner('worktree-1', SPLIT, handlers())).toBe(false)
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
  })
})
