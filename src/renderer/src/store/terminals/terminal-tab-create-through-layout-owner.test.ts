import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import type { LayoutApplyReply } from '../../../../shared/workspace-layout/workspace-layout-command-types'
import {
  _resetLayoutFramePositionForTests,
  beginLayoutFramePositions,
  endLayoutFramePositions,
  noteLayoutFramePosition
} from '@/runtime/layout-frame-position'
import {
  _resetLayoutOwnerPaneIntentsForTests,
  takeTabRowFields
} from '@/runtime/layout-owner-pane-intents'
import { createTestStore, makeTab } from '../slices/store-test-helpers'
import {
  createInitialTerminalThroughLayoutOwner,
  recordCreatedTerminalTabInLayoutOwner
} from './terminal-tab-create-through-layout-owner'

const mocks = vi.hoisted(() => {
  const held: {
    pairedServer: string | null
    twin: boolean
    reply: ((value: LayoutApplyReply) => void) | null
    fail: ((error: Error) => void) | null
  } = { pairedServer: null, twin: false, reply: null, fail: null }
  return Object.assign(held, { callRuntimeRpc: vi.fn() })
})

vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.callRuntimeRpc }))
vi.mock('@/lib/resolve-owner', () => ({
  runtimeEnvironmentIdUnlessTwin: () => mocks.pairedServer,
  runtimeEnvironmentIdForWorkspaceOwner: () =>
    mocks.twin ? { kind: 'ambiguous' } : { kind: 'resolved', environmentId: null }
}))

const WORKTREE = 'repo1::/path/wt'

function stateWith(tabIds: string[] = [], activeWorktreeId = WORKTREE): AppState {
  const store = createTestStore()
  store.setState({
    activeWorktreeId,
    tabsByWorktree: { [WORKTREE]: tabIds.map((id) => makeTab({ id, worktreeId: WORKTREE })) }
  })
  return store.getState()
}

function start(state: () => AppState = () => stateWith()) {
  const create = vi.fn()
  const routed = createInitialTerminalThroughLayoutOwner(state, WORKTREE, create)
  const command = mocks.callRuntimeRpc.mock.calls[0]?.[2]?.command
  return { create, routed, command }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  _resetLayoutOwnerPaneIntentsForTests()
  endLayoutFramePositions()
  mocks.pairedServer = null
  mocks.twin = false
  mocks.callRuntimeRpc.mockReset()
  mocks.callRuntimeRpc.mockImplementation(
    () =>
      new Promise<LayoutApplyReply>((resolve, reject) => {
        mocks.reply = resolve
        mocks.fail = reject
      })
  )
})

describe('createInitialTerminalThroughLayoutOwner', () => {
  it('asks main for the first tab and leaves drawing it, with the window’s row fields, to main’s frame', async () => {
    const { create, routed, command } = start()

    expect(routed).toBe(true)
    expect(command).toMatchObject({
      type: 'createTerminalTab',
      workspace: WORKTREE,
      initial: 'activation'
    })
    noteLayoutFramePosition(1)
    mocks.reply?.({ ok: true, result: { tabId: command.tabId, leafId: command.leafId } })
    await settle()

    expect(create).not.toHaveBeenCalled()
    // Kept for the frame, however late an owed write lets it in.
    expect(takeTabRowFields(command.tabId)).toEqual({ pendingActivationSpawn: true })
  })

  it('draws nothing itself when no frame is coming: the reopened stream’s snapshot brings it', async () => {
    const { create, command } = start()

    mocks.reply?.({ ok: true, result: { tabId: command.tabId, leafId: command.leafId } })
    await settle()

    expect(create).not.toHaveBeenCalled()
    expect(takeTabRowFields(command.tabId)).toEqual({ pendingActivationSpawn: true })
  })

  it('draws nothing itself when the stream ends before main’s frame', async () => {
    _resetLayoutFramePositionForTests()
    beginLayoutFramePositions()
    const { create, command } = start()

    mocks.reply?.({
      ok: true,
      result: { tabId: command.tabId, leafId: command.leafId },
      frameSeq: 1
    })
    await settle()
    endLayoutFramePositions()

    expect(create).not.toHaveBeenCalled()
    expect(takeTabRowFields(command.tabId)).toEqual({ pendingActivationSpawn: true })
  })

  it('draws nothing itself when a frame showed the tab before the stream ended', async () => {
    let state = stateWith()
    const { create, command } = start(() => state)

    state = stateWith([command.tabId])
    mocks.reply?.({ ok: true, result: { tabId: command.tabId, leafId: command.leafId } })
    await settle()

    expect(create).not.toHaveBeenCalled()
  })

  it('draws nothing when main’s copy already has a tab there', async () => {
    const { create, command } = start()

    mocks.reply?.({ ok: true, result: {} })
    await settle()

    expect(create).not.toHaveBeenCalled()
    expect(takeTabRowFields(command.tabId)).toBeNull()
  })

  it('opens the terminal as today when main holds no partition for the workspace, or fails', async () => {
    const unowned = start()
    mocks.reply?.({ ok: false, code: 'host_not_owned' })
    await settle()
    expect(unowned.create).toHaveBeenCalledWith()

    mocks.callRuntimeRpc.mockClear()
    const failed = start()
    mocks.fail?.(new Error('layout_store_unavailable'))
    await settle()
    expect(failed.create).toHaveBeenCalledWith()
    expect(takeTabRowFields(failed.command.tabId)).toBeNull()
  })

  it('opens nothing as today once the user has left the workspace', async () => {
    let state = stateWith()
    const { create } = start(() => state)

    state = stateWith([], 'repo1::/path/other')
    mocks.reply?.({ ok: false, code: 'host_not_owned' })
    await settle()

    expect(create).not.toHaveBeenCalled()
  })

  it('opens nothing as today once the workspace got a tab meanwhile', async () => {
    let state = stateWith()
    const { create } = start(() => state)

    state = stateWith(['tab-opened-meanwhile'])
    mocks.fail?.(new Error('layout_store_unavailable'))
    await settle()

    expect(create).not.toHaveBeenCalled()
  })

  it('leaves a paired server’s workspace to the caller', () => {
    mocks.pairedServer = 'env-1'

    const { routed } = start()

    expect(routed).toBe(false)
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
  })
})

describe('recordCreatedTerminalTabInLayoutOwner', () => {
  const command = {
    type: 'createTerminalTab' as const,
    workspace: WORKTREE,
    tabId: 'tab-drawn',
    leafId: 'leaf-drawn'
  }

  it.each([
    [false, 1],
    [true, 0]
  ])(
    'on host_not_owned (twin: %s), closes the drawn tab unless a paired server may hold it',
    async (twin, closes) => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      mocks.twin = twin
      const state = stateWith(['tab-drawn'])
      const closeTab = vi.fn()
      recordCreatedTerminalTabInLayoutOwner({ ...state, closeTab }, command)
      mocks.reply?.({ ok: false, code: 'host_not_owned' })
      await settle()
      expect(closeTab).toHaveBeenCalledTimes(closes)
    }
  )
})
