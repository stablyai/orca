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

import { recordLayoutApply, sendLayoutApply } from './layout-apply-send'
import { isDrawnGroupLayoutHeld, isDrawnTabHeld } from './layout-owner-drawn-tab-holds'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the owner lookup is mocked and never reads the state.
const NO_STATE = {} as never

const RENAME = { type: 'renamePane', tabId: 'tab-1', leafId: 'leaf-1', title: 'Pane' } as const

async function send(reply: LayoutApplyReply | Error) {
  mocks.sent.reply = reply
  const handlers = { apply: vi.fn(), asToday: vi.fn(), refused: vi.fn() }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the owner lookup is mocked and never reads the state.
  sendLayoutApply({} as never, 'wt-1', RENAME, handlers)
  await vi.waitFor(() => {
    const calls = Object.values(handlers).reduce(
      (sum, handler) => sum + handler.mock.calls.length,
      0
    )
    expect(calls).toBe(1)
  })
  return handlers
}

describe('sendLayoutApply', () => {
  beforeEach(() => {
    mocks.owner.kind = 'resolved'
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  // A window save no longer carries the change, so doing it here would last only until the next frame.
  it.each([
    { reply: { ok: false, code: 'other_partition' } as const, code: 'other_partition' },
    { reply: { ok: false, code: 'host_not_owned' } as const, code: 'host_not_owned' },
    { reply: new Error('disk refused'), code: 'call_failed' },
    // Main's copy lacking the target is a refusal too: a frame drew what the window shows.
    { reply: { ok: false, code: 'tab_not_found' } as const, code: 'tab_not_found' },
    { reply: { ok: false, code: 'pane_not_found' } as const, code: 'pane_not_found' },
    { reply: { ok: false, code: 'workspace_not_found' } as const, code: 'workspace_not_found' },
    { reply: { ok: false, code: 'group_not_found' } as const, code: 'group_not_found' }
  ])('logs a $code refusal and draws nothing of its own', async ({ reply, code }) => {
    const handlers = await send(reply)

    expect(handlers.refused).toHaveBeenCalledWith(code)
    expect(handlers.asToday).not.toHaveBeenCalled()
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining(`[layout-owner] renamePane refused`),
      ...(reply instanceof Error ? ['disk refused'] : [code])
    )
  })

  it('acts as today on a twin main routed to a paired server', async () => {
    mocks.owner.kind = 'ambiguous'
    const handlers = await send({ ok: false, code: 'host_not_owned' })

    expect(handlers.asToday).toHaveBeenCalledOnce()
    expect(handlers.refused).not.toHaveBeenCalled()
  })

  it('refuses a change on a workspace a WSL move has paused, drawing nothing', async () => {
    const handlers = await send({ ok: false, code: 'wsl_move_in_progress' })

    expect(handlers.refused).toHaveBeenCalledWith('wsl_move_in_progress')
    expect(handlers.apply).not.toHaveBeenCalled()
    expect(console.warn).toHaveBeenCalledWith(
      '[layout-owner] renamePane refused:',
      'wsl_move_in_progress'
    )
  })

  it('handles other refusals and successes as before', async () => {
    const refused = await send({ ok: false, code: 'last_pane' })
    expect(refused.refused).toHaveBeenCalledWith('last_pane')

    const applied = await send({ ok: true, result: { tabId: 'tab-1' } })
    expect(applied.apply).toHaveBeenCalledWith({ tabId: 'tab-1' }, LOCAL_LAYOUT_APPLY_ORIGIN)
  })

  it('holds the tabs a drawn change names until its answer is in, but no move main draws first', async () => {
    mocks.sent.reply = { ok: true, result: {} }
    recordLayoutApply(NO_STATE, 'wt-1', { type: 'closeTabs', tabIds: ['tab-1'] })
    // A restored tab's move is sent before the window draws it: its frame draws it.
    recordLayoutApply(NO_STATE, 'wt-1', {
      type: 'moveTabToWorkspace',
      toWorkspace: 'wt-2',
      tabs: [{ tabId: 'tab-2', newTabId: 'tab-2b', newEntityId: 'file-2b' }],
      groupId: 'group-2'
    })
    expect(isDrawnTabHeld('wt-1', 'tab-1')).toBe(true)
    expect(isDrawnTabHeld('wt-1', 'tab-2')).toBe(false)
    expect(isDrawnTabHeld('wt-2', 'tab-2b')).toBe(false)
    await vi.waitFor(() => expect(isDrawnTabHeld('wt-1', 'tab-1')).toBe(false))
  })

  it('holds group sizes the window set, and nothing for a change main draws first', async () => {
    mocks.sent.reply = { ok: true, result: {} }
    const keep = vi.fn()
    sendLayoutApply(
      NO_STATE,
      'wt-1',
      { type: 'setGroupRatios', ratios: [{ path: '', ratio: 0.3 }] },
      {
        apply: keep,
        asToday: keep,
        drawn: true
      }
    )
    sendLayoutApply(
      NO_STATE,
      'wt-1',
      { type: 'moveTab', tabId: 'tab-9', toGroupId: 'g', index: 0 },
      {
        apply: keep,
        asToday: keep
      }
    )
    expect(isDrawnGroupLayoutHeld('wt-1')).toBe(true)
    expect(isDrawnTabHeld('wt-1', 'tab-9')).toBe(false)
    await vi.waitFor(() => expect(isDrawnGroupLayoutHeld('wt-1')).toBe(false))
  })
})

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

  it("frees them when the answer came but main's frame never did", async () => {
    mocks.sent.reply = { ok: true, result: {} }
    mocks.frame.arrives = false
    const handlers = sendHeld('wt-no-frame')

    await vi.advanceTimersByTimeAsync(15_000)
    await vi.advanceTimersByTimeAsync(1)

    expect(isDrawnGroupLayoutHeld('wt-no-frame')).toBe(false)
    ranNoHandler(handlers)
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
