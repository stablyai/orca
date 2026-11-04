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

vi.mock('../../../shared/stable-pane-id', async (importOriginal) => {
  const original = await importOriginal<typeof stablePaneId>()
  return { ...original, parsePaneKey: vi.fn(original.parsePaneKey) }
})

import { sendLayoutApply } from './layout-apply-send'
import { afterWorkspaceLayoutCommands } from './layout-apply-call'
import { isDrawnGroupLayoutHeld } from './layout-owner-drawn-tab-holds'
import { recordSleepingRecordChangesThroughLayoutOwner } from '@/store/terminals/terminal-sleep-layout-owner'
import { callRuntimeRpc } from './runtime-rpc-client'
import { LayoutApplyParams } from '../../../shared/rpc-contract/workspace-layout-params'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-resume'
import { createTestStore, makeTab, seedStore } from '@/store/slices/store-test-helpers'
import { useAppStore } from '@/store'
import { followSleepingRecordsInLayoutOwner } from './sleeping-records-to-layout-owner'
import * as stablePaneId from '../../../shared/stable-pane-id'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the owner lookup is mocked and never reads the state.
const NO_STATE = {} as never

const RENAME = { type: 'renamePane', tabId: 'tab-1', leafId: 'leaf-1', title: 'Pane' } as const

it('carries the observed record or observed absence through the existing renderer sleep/wake intent', async () => {
  vi.useRealTimers()
  mocks.frame.arrives = true
  mocks.owner.kind = 'resolved'
  mocks.sent.reply = { ok: true, result: {} }
  vi.mocked(callRuntimeRpc).mockClear()
  const workspace = 'resume-observation'
  const record: SleepingAgentSessionRecord = {
    paneKey: 'tab:11111111-1111-4111-8111-111111111111',
    worktreeId: workspace,
    agent: 'codex',
    providerSession: { key: 'session_id', id: 'observed-session' },
    prompt: '',
    state: 'done',
    capturedAt: 1,
    updatedAt: 1,
    origin: 'live'
  }
  const state = {
    tabsByWorktree: {
      [workspace]: [
        {
          id: 'tab',
          ptyId: null,
          worktreeId: workspace,
          title: '',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    }
  }
  const captured = { [record.paneKey]: record }
  recordSleepingRecordChangesThroughLayoutOwner(state, {}, captured)
  await afterWorkspaceLayoutCommands({ kind: 'local' }, workspace, async () => {})
  const first = LayoutApplyParams.parse(vi.mocked(callRuntimeRpc).mock.calls[0]![2]).command
  expect(first).toMatchObject({ type: 'sleep', expectedRecords: { [record.paneKey]: null } })
  mocks.sent.reply = { ok: false, code: 'pane_structure_changed' }
  const conflict = vi.fn()
  recordSleepingRecordChangesThroughLayoutOwner(state, captured, {}, conflict)
  await afterWorkspaceLayoutCommands({ kind: 'local' }, workspace, async () => {})
  const second = LayoutApplyParams.parse(vi.mocked(callRuntimeRpc).mock.calls[1]![2]).command
  expect(second).toMatchObject({ type: 'wake', expectedRecords: captured })
  expect(conflict).toHaveBeenCalledExactlyOnceWith(workspace, [record.paneKey])
  expect(callRuntimeRpc).toHaveBeenCalledTimes(2)
})

it('groups N and 10N same-tab and wide-tab sleeping records linearly', async () => {
  vi.useRealTimers()
  mocks.frame.arrives = true
  mocks.owner.kind = 'resolved'
  mocks.sent.reply = { ok: true, result: {} }
  const workspace = 'repo::/sleep-scaling'
  const store = createTestStore()
  seedStore(store, { tabsByWorktree: {} })
  const subscription = vi.spyOn(useAppStore, 'subscribe').mockImplementation(store.subscribe)
  followSleepingRecordsInLayoutOwner()
  try {
    for (const wide of [false, true]) {
      for (const count of [20, 200]) {
        let tabVisits = 0
        const tabs = Array.from({ length: wide ? count : 1 }, (_, index) => {
          const id = `tab-${index}`
          const tab = makeTab({ id, worktreeId: workspace })
          Object.defineProperty(tab, 'id', {
            get: () => {
              tabVisits++
              return id
            },
            enumerable: true,
            configurable: true
          })
          return tab
        })
        store.setState({
          tabsByWorktree: { [workspace]: tabs },
          sleepingAgentSessionsByPaneKey: {}
        })
        await afterWorkspaceLayoutCommands({ kind: 'local' }, workspace, async () => {})
        const live = Array.from({ length: count }, (_, index): SleepingAgentSessionRecord => ({
          paneKey: `tab-${wide ? index : 0}:${index.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`,
          worktreeId: workspace,
          agent: 'codex',
          providerSession: { key: 'session_id', id: `session-${index}` },
          prompt: '',
          state: 'done',
          capturedAt: 1,
          updatedAt: count,
          origin: 'live'
        }))
        store.setState({
          sleepingAgentSessionsByPaneKey: Object.fromEntries(
            live.map((record) => [record.paneKey, record])
          )
        })
        await afterWorkspaceLayoutCommands({ kind: 'local' }, workspace, async () => {})
        const records = live.map((record) => ({ ...record, origin: 'quit' as const }))
        const known = new Set<unknown>(records)
        const put = Map.prototype.set
        let copiedRecords = 0
        Map.prototype.set = function (key, value) {
          if (Array.isArray(value) && known.has(value[0])) {
            const iterate = value[Symbol.iterator].bind(value)
            value[Symbol.iterator] = function* (): Generator<unknown, undefined, unknown> {
              copiedRecords += value.length
              yield* iterate()
              return undefined
            }
          }
          return put.call(this, key, value)
        }
        vi.mocked(callRuntimeRpc).mockClear()
        vi.mocked(stablePaneId.parsePaneKey).mockClear()
        tabVisits = 0
        try {
          store.setState({
            sleepingAgentSessionsByPaneKey: Object.fromEntries(
              records.map((record) => [record.paneKey, record])
            )
          })
          await afterWorkspaceLayoutCommands({ kind: 'local' }, workspace, async () => {})
          expect(callRuntimeRpc).toHaveBeenCalledTimes(wide ? count : 1)
          const commands = vi
            .mocked(callRuntimeRpc)
            .mock.calls.map((call) => LayoutApplyParams.parse(call[2]).command)
          expect(commands.every((command) => command.type === 'sleep')).toBe(true)
          expect(
            commands.flatMap((command) => (command.type === 'sleep' ? (command.records ?? []) : []))
          ).toEqual(records)
          expect(copiedRecords).toBeLessThanOrEqual(count * 8)
          expect(tabVisits).toBeGreaterThan(0)
          expect(tabVisits).toBeLessThanOrEqual(count * 8)
          expect(stablePaneId.parsePaneKey).toHaveBeenCalled()
          expect(vi.mocked(stablePaneId.parsePaneKey).mock.calls.length).toBeLessThanOrEqual(
            count * 8
          )
          vi.mocked(callRuntimeRpc).mockClear()
          store.setState({ activeWorktreeId: 'unrelated::/workspace' })
          await afterWorkspaceLayoutCommands({ kind: 'local' }, workspace, async () => {})
          expect(callRuntimeRpc).not.toHaveBeenCalled()
          if (wide) {
            vi.mocked(stablePaneId.parsePaneKey).mockClear()
            tabVisits = 0
            store.setState({ sleepingAgentSessionsByPaneKey: {} })
            await afterWorkspaceLayoutCommands({ kind: 'local' }, workspace, async () => {})
            expect(callRuntimeRpc).toHaveBeenCalledTimes(count)
            expect(
              vi
                .mocked(callRuntimeRpc)
                .mock.calls.every(
                  (call) => LayoutApplyParams.parse(call[2]).command.type === 'wake'
                )
            ).toBe(true)
            expect(tabVisits).toBeLessThanOrEqual(count * 8)
            expect(vi.mocked(stablePaneId.parsePaneKey).mock.calls.length).toBeLessThanOrEqual(
              count * 8
            )
          }
        } finally {
          Map.prototype.set = put
        }
      }
    }
  } finally {
    subscription.mockRestore()
  }
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

describe('ordinary content command ordering', () => {
  it('defers a close until its earlier creation has settled, without blocking another workspace', async () => {
    let finishCreate!: () => void
    const order: string[] = []
    const creation = afterWorkspaceLayoutCommands(
      { kind: 'local' },
      'ordered-create-close',
      () =>
        new Promise<void>((resolve) => {
          order.push('create-dispatched')
          finishCreate = resolve
        })
    )
    const close = afterWorkspaceLayoutCommands(
      { kind: 'local' },
      'ordered-create-close',
      async () => {
        order.push('close-dispatched')
      }
    )
    await afterWorkspaceLayoutCommands({ kind: 'local' }, 'independent-workspace', async () => {
      order.push('other-dispatched')
    })
    expect(order).toEqual(['create-dispatched', 'other-dispatched'])
    finishCreate()
    await Promise.all([creation, close])
    expect(order).toEqual(['create-dispatched', 'other-dispatched', 'close-dispatched'])
  })

  it('releases a rejected creation and later reuses the workspace after settlement', async () => {
    let rejectCreate!: (error: Error) => void
    const creation = afterWorkspaceLayoutCommands(
      { kind: 'local' },
      'refused-create-close',
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectCreate = reject
        })
    )
    const close = vi.fn(async () => 'closed')
    const closing = afterWorkspaceLayoutCommands({ kind: 'local' }, 'refused-create-close', close)
    const rejected = expect(creation).rejects.toThrow('refused')
    rejectCreate(new Error('refused'))
    await rejected
    expect(await closing).toBe('closed')
    expect(close).toHaveBeenCalledOnce()
    expect(
      await afterWorkspaceLayoutCommands(
        { kind: 'local' },
        'refused-create-close',
        async () => 'reused'
      )
    ).toBe('reused')
  })
})
