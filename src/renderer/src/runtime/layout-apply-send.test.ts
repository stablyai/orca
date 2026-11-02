import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_LAYOUT_APPLY_ORIGIN } from './server-layout-apply-routes'
import type { LayoutApplyReply } from '../../../shared/workspace-layout/workspace-layout-command-types'

const mocks = vi.hoisted(() => {
  const sent: { reply: LayoutApplyReply | Error | Promise<LayoutApplyReply> } = {
    reply: { ok: true, result: {} }
  }
  const owner: { kind: 'resolved' | 'ambiguous' } = { kind: 'resolved' }
  // A frame that never comes keeps its waiter here.
  const frame: { arrives: boolean; waiting: (() => void)[] } = { arrives: true, waiting: [] }
  const paneRelease = vi.fn()
  return { sent, owner, frame, paneRelease }
})
vi.mock('@/lib/resolve-owner', () => ({
  runtimeEnvironmentIdUnlessTwin: () => null,
  runtimeEnvironmentIdForWorkspaceOwner: () =>
    mocks.owner.kind === 'resolved' ? { kind: 'resolved', environmentId: null } : mocks.owner
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: vi.fn(async () => {
    if (mocks.sent.reply instanceof Error) {
      throw mocks.sent.reply
    }
    return mocks.sent.reply
  })
}))
vi.mock('@/runtime/layout-frame-position', () => ({
  afterLayoutFrame: (_seq: number | undefined, run: () => void) =>
    mocks.frame.arrives ? run() : mocks.frame.waiting.push(run),
  layoutFramePositionKey: () => 'local'
}))
vi.mock('@/runtime/layout-owner-pane-intents', () => ({
  holdTabPaneTree: () => mocks.paneRelease
}))

import { sendLayoutApply } from './layout-apply-send'
import { isDrawnGroupLayoutHeld } from './layout-owner-drawn-tab-holds'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the owner lookup is mocked and never reads the state.
const NO_STATE = {} as never

const RENAME = { type: 'renamePane', tabId: 'tab-1', leafId: 'leaf-1', title: 'Pane' } as const

describe('sendLayoutApply holds with no answer', () => {
  const RATIOS: Parameters<typeof sendLayoutApply>[2] = {
    type: 'setGroupRatios',
    ratios: [{ path: '', ratio: 0.3 }]
  }
  const NO_ANSWER = 'setGroupRatios hold released: no answer in 15s'

  beforeEach(() => {
    vi.useFakeTimers()
    mocks.frame.arrives = true
    mocks.frame.waiting = []
    mocks.paneRelease.mockClear()
    vi.spyOn(console, 'warn')
      .mockClear()
      .mockImplementation(() => {})
    return () => vi.useRealTimers()
  })

  function sendHeld(workspace: string, command: Parameters<typeof sendLayoutApply>[2] = RATIOS) {
    const handlers = { apply: vi.fn(), asToday: vi.fn(), refused: vi.fn(), drawn: true as const }
    sendLayoutApply(NO_STATE, workspace, command, handlers)
    return handlers
  }

  function ranNoHandler(handlers: ReturnType<typeof sendHeld>): void {
    expect(handlers.apply).not.toHaveBeenCalled()
    expect(handlers.asToday).not.toHaveBeenCalled()
    expect(handlers.refused).not.toHaveBeenCalled()
  }

  it('frees the holds 15 s after a call that never answers, runs no handler and warns once', async () => {
    mocks.sent.reply = new Promise<LayoutApplyReply>(() => {})
    const handlers = sendHeld('wt-silent')

    await vi.advanceTimersByTimeAsync(14_999)
    expect(isDrawnGroupLayoutHeld('wt-silent')).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(1)

    expect(isDrawnGroupLayoutHeld('wt-silent')).toBe(false)
    ranNoHandler(handlers)
    expect(console.warn).toHaveBeenCalledOnce()
    expect(console.warn).toHaveBeenCalledWith(`[layout-owner] ${NO_ANSWER}`)
  })

  it("frees a pane command's tree hold too, once, and a late frame still runs its handler", async () => {
    mocks.sent.reply = { ok: true, result: { tabId: 'tab-1' } }
    mocks.frame.arrives = false
    const handlers = sendHeld('wt-pane', RENAME)

    await vi.advanceTimersByTimeAsync(15_000)
    await vi.advanceTimersByTimeAsync(1)
    expect(mocks.paneRelease).toHaveBeenCalledOnce()

    mocks.frame.waiting.forEach((run) => run())
    await vi.advanceTimersByTimeAsync(1)
    expect(handlers.apply).toHaveBeenCalledWith({ tabId: 'tab-1' }, LOCAL_LAYOUT_APPLY_ORIGIN)
    expect(mocks.paneRelease).toHaveBeenCalledOnce()
    expect(console.warn).toHaveBeenCalledOnce()
  })

  it('an answer in time stops the timer', async () => {
    mocks.sent.reply = { ok: true, result: {} }
    const handlers = sendHeld('wt-answered')

    await vi.advanceTimersByTimeAsync(0)
    expect(handlers.apply).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(20_000)

    expect(console.warn).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
