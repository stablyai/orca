// A stand-in for main's `layout.apply` and `layout.subscribe` in switch-on renderer tests. It answers
// each command the window sends (accept, apply to main's model, leave pending, or refuse) and, when
// applying, emits main's frame at the reply's stream position, as main does.
//
// Install it in a test file, before any import that reaches the RPC client:
//   vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
//     (await import('@/runtime/layout-apply-test-transport.test-fixture'))
//       .runtimeRpcClientWithLayoutApply(await importOriginal()))
// and, for frames, `@/runtime/runtime-layout-client` with `runtimeLayoutClientWithTestFrames`.
// Imports stay clear of the RPC client at runtime: a mock factory must not reach what it replaces.

import { createBrowserUuid } from '@/lib/browser-uuid'
import { applyLayoutCommand } from '../../../shared/workspace-layout/workspace-layout-commands'
import type {
  LayoutApplyReply,
  LayoutCommand,
  LayoutCommandResult
} from '../../../shared/workspace-layout/workspace-layout-command-types'
import type { WorkspaceLayoutModel } from '../../../shared/workspace-layout/workspace-layout-model'
import {
  publishWorkspaceLayout,
  type PublishedWorkspaceLayout
} from '../../../shared/workspace-layout/workspace-layout-published'
import {
  diffPublishedLayouts,
  indexPublishedLayout,
  type WorkspaceLayoutRecordChange
} from '../../../shared/workspace-layout/workspace-layout-records'
import type { WorkspaceLayoutChangeFrame } from '../../../shared/workspace-layout/workspace-layout-stream-frames'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { layoutSnapshotFrame, publishedLayoutsOf } from './main-loaded-layout-frames.test-fixture'
import { throwLayoutFrameApplyErrors } from './workspace-layout-frame-apply-check.test-fixture'
import {
  layoutFrameApplyObserver,
  observeLayoutFrameApply
} from './workspace-layout-frame-apply-observer'
import type * as LayoutClient from './runtime-layout-client'
import type * as RpcClient from './runtime-rpc-client'

type Refusal = Extract<LayoutApplyReply, { ok: false }>['code']

/**
 * `accept`: ok, with a result naming the ids the command did; no frame (main's copy is not
 * modelled). `apply`: main's model (`useMainModel`) applies it; the reply carries its real result
 * and the position of the frame emitted with it. `pending`: no answer until `answerPending`. A
 * function answers per command, or returns `apply` to apply it.
 */
export type LayoutApplyTestAnswer =
  | 'accept'
  | 'apply'
  | 'pending'
  | { refuse: Refusal }
  | ((command: LayoutCommand) => LayoutApplyReply | 'pending' | 'apply')

type FrameSink = {
  onFrame: (frame: WorkspaceLayoutChangeFrame) => void
  onPosition?: (seq: number) => void
}

type PendingApply = { command: LayoutCommand; resolve: (reply: LayoutApplyReply) => void }

type TransportState = {
  answer: LayoutApplyTestAnswer
  sent: LayoutCommand[]
  pending: PendingApply[]
  model: WorkspaceLayoutModel | null
  seq: number
  sinks: Set<FrameSink>
  inFlight: Promise<LayoutApplyReply>[]
}

const fresh = (): TransportState => ({
  answer: 'accept',
  sent: [],
  pending: [],
  model: null,
  seq: 0,
  sinks: new Set(),
  inFlight: []
})

let state = fresh()

/** What main's result names for a command it accepted, read off the command. */
function acceptedResult(command: LayoutCommand): LayoutCommandResult {
  const result: LayoutCommandResult = {}
  if ('tabId' in command && typeof command.tabId === 'string') {
    result.tabId = command.tabId
  }
  if ('leafId' in command && typeof command.leafId === 'string') {
    result.leafId = command.leafId
  }
  if ('groupId' in command && typeof command.groupId === 'string') {
    result.groupId = command.groupId
  }
  if ('pageId' in command && typeof command.pageId === 'string') {
    result.pageId = command.pageId
  }
  if (command.type === 'closeTabs') {
    return { ...result, closed: [...command.tabIds], refused: [] }
  }
  if (command.type === 'sleep') {
    return { ...result, slept: [...(command.paneKeys ?? [])] }
  }
  if (command.type === 'wake') {
    return { ...result, woken: [...(command.paneKeys ?? [])] }
  }
  if (command.type === 'splitPane' && command.newLeafId) {
    return { ...result, leafId: command.newLeafId }
  }
  return result
}

// Shape check only: the window's own sender built it.
function isLayoutCommand(value: unknown): value is LayoutCommand {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof value.type === 'string' &&
    'workspace' in value &&
    typeof value.workspace === 'string'
  )
}

/** The command of a `layout.apply` request's params. */
function commandOf(params: unknown): unknown {
  return typeof params === 'object' && params !== null && 'command' in params
    ? params.command
    : undefined
}

function emit(frame: WorkspaceLayoutChangeFrame): void {
  for (const sink of state.sinks) {
    sink.onFrame(frame)
    if (frame.seq !== undefined) {
      sink.onPosition?.(frame.seq)
    }
  }
}

const TEST_EPOCH = 'layout-apply-test-epoch'

/** One workspace's records an operation changed, as main's stream publishes them. */
function recordChanges(
  key: string,
  before: PublishedWorkspaceLayout | undefined,
  after: PublishedWorkspaceLayout | undefined
): WorkspaceLayoutRecordChange[] {
  if (!after) {
    return [{ key, change: 'removed' }]
  }
  const change = before
    ? diffPublishedLayouts(key, indexPublishedLayout(before), indexPublishedLayout(after), after)
    : { key, change: 'layout' as const, layout: after }
  return change ? [change] : []
}

/** Main's apply without its routing: no host partitions, `host_not_owned`, forced closes, or a
 *  frame position on refusals. */
function applyToMainModel(command: LayoutCommand): LayoutApplyReply {
  const model = state.model
  if (!model) {
    throw new Error('layoutApplyTestTransport: answer "apply" needs useMainModel first')
  }
  const applied = applyLayoutCommand(model, command, {
    mintId: createBrowserUuid,
    mintLeafId: createBrowserUuid,
    now: () => Date.now()
  })
  if (!applied.ok) {
    return applied
  }
  state.model = applied.model
  state.seq += 1
  const seq = state.seq
  // Main publishes the operation's records, in every workspace it changed (a move changes two),
  // before it replies.
  const keys = new Set([...Object.keys(model.workspaces), ...Object.keys(applied.model.workspaces)])
  emit({
    type: 'records',
    epoch: TEST_EPOCH,
    seq,
    workspaces: [...keys].flatMap((key) => {
      const before = model.workspaces[key]
      const workspace = applied.model.workspaces[key]
      return before === workspace
        ? []
        : recordChanges(
            key,
            before && publishWorkspaceLayout(before, model.hostId),
            workspace && publishWorkspaceLayout(workspace, model.hostId)
          )
    })
  })
  return { ok: true, result: applied.result, frameSeq: seq }
}

/** The current answer to one command; `pending` when it waits for `answerPending`. */
function replyTo(command: LayoutCommand): LayoutApplyReply | 'pending' {
  const answer = state.answer
  if (typeof answer === 'function') {
    const reply = answer(command)
    return reply === 'apply' ? applyToMainModel(command) : reply
  }
  if (answer === 'accept') {
    return { ok: true, result: acceptedResult(command) }
  }
  if (answer === 'apply') {
    return applyToMainModel(command)
  }
  return answer === 'pending' ? 'pending' : { ok: false, code: answer.refuse }
}

function answerCommand(command: LayoutCommand): Promise<LayoutApplyReply> {
  state.sent.push(command)
  const reply = replyTo(command)
  if (reply === 'pending') {
    return new Promise((resolve) => state.pending.push({ command, resolve }))
  }
  const answered = Promise.resolve(reply)
  state.inFlight.push(answered)
  return answered
}

// layout-apply-send.ts's chain (reply, frame wait, handler) runs a few microtasks after the answer.
const REPLY_CHAIN_TURNS = 5

export const layoutApplyTestTransport = {
  /** How later commands are answered; `accept` after each `reset`. */
  answerWith(answer: LayoutApplyTestAnswer): void {
    state.answer = answer
  },
  /** Main's model, which `apply` edits and frames publish. */
  useMainModel(model: WorkspaceLayoutModel): void {
    state.model = model
  },
  get mainModel(): WorkspaceLayoutModel | null {
    return state.model
  },
  /** Every command sent, in order, with its workspace. */
  get sent(): readonly LayoutCommand[] {
    return state.sent
  },
  sentOfType<T extends LayoutCommand['type']>(type: T): Extract<LayoutCommand, { type: T }>[] {
    return state.sent.filter(
      (command): command is Extract<LayoutCommand, { type: T }> => command.type === type
    )
  },
  get pendingCount(): number {
    return state.pending.length
  },
  /** Answers every pending command: with `reply`, else as the current answer (`accept` when that
   *  is still `pending`). */
  answerPending(reply?: LayoutApplyReply): void {
    const pending = state.pending
    state.pending = []
    for (const { command, resolve } of pending) {
      const next = replyTo(command)
      const answer =
        reply ?? (next === 'pending' ? { ok: true, result: acceptedResult(command) } : next)
      state.inFlight.push(Promise.resolve(answer))
      resolve(answer)
    }
  },
  /** Resolves once every answered command's handler ran; real or fake timers alike. */
  async settle(): Promise<void> {
    while (state.inFlight.length > 0) {
      const answered = state.inFlight
      state.inFlight = []
      await Promise.all(answered)
      for (let turn = 0; turn < REPLY_CHAIN_TURNS; turn += 1) {
        await Promise.resolve()
      }
    }
  },
  /** Sends a frame main made on its own (a CLI create, a load repair). */
  emitFrame(frame: WorkspaceLayoutChangeFrame): void {
    emit(frame)
  },
  /** Answers one `layout.apply` request's params; the RPC mock below routes here. */
  call(params: unknown): Promise<LayoutApplyReply> {
    const command = commandOf(params)
    if (!isLayoutCommand(command)) {
      return Promise.reject(new Error('layout.apply without a command'))
    }
    return answerCommand(command)
  },
  reset(): void {
    state = fresh()
  }
}

type RpcClientModule = typeof RpcClient

/** The RPC client module with local `layout.apply` answered by the transport. */
export function runtimeRpcClientWithLayoutApply(actual: RpcClientModule): RpcClientModule {
  function callRuntimeRpc<TResult>(
    target: RuntimeClientTarget,
    method: string,
    params?: unknown,
    options?: Parameters<RpcClientModule['callRuntimeRpc']>[3]
  ): Promise<TResult> {
    if (target.kind === 'local' && method === 'layout.apply') {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: callers of layout.apply type TResult as LayoutApplyReply.
      return layoutApplyTestTransport.call(params) as Promise<TResult>
    }
    return actual.callRuntimeRpc<TResult>(target, method, params, options)
  }
  const client = { ...actual, callRuntimeRpc }
  // Why: vi.resetModules keeps the mocked client, so a test's later import of this fixture is a
  // fresh copy; tests read the copy the mocked client answers with from this property.
  Object.defineProperty(client, ANSWERING_TRANSPORT, { value: layoutApplyTestTransport })
  return client
}

export const ANSWERING_TRANSPORT = 'layoutApplyTestTransport'

type LayoutClientModule = typeof LayoutClient

/** The layout client module with the local stream fed by the transport: main's model's snapshot
 *  first, then the frames `apply` and `emitFrame` send. */
export function runtimeLayoutClientWithTestFrames(actual: LayoutClientModule): LayoutClientModule {
  const subscribeRuntimeLayout: LayoutClientModule['subscribeRuntimeLayout'] = (
    target,
    params,
    onFrame,
    onStatus,
    onPosition
  ) => {
    if (target.kind !== 'local') {
      return actual.subscribeRuntimeLayout(target, params, onFrame, onStatus, onPosition)
    }
    const sink: FrameSink = { onFrame, onPosition }
    state.sinks.add(sink)
    // Every flush of the window's frames must show what the full build shows; a test's own
    // installed check keeps reporting it.
    const previousCheck = layoutFrameApplyObserver()
    const installedCheck = previousCheck ?? throwLayoutFrameApplyErrors
    observeLayoutFrameApply(installedCheck)
    onStatus({ state: 'connecting' })
    queueMicrotask(() => {
      if (!state.sinks.has(sink)) {
        return
      }
      onStatus({ state: 'live' })
      onFrame(layoutSnapshotFrame(state.model ? publishedLayoutsOf(state.model) : {}, state.seq))
      onPosition?.(state.seq)
    })
    return {
      close: () => {
        state.sinks.delete(sink)
        // A check installed after this one (another stream or test) stays in place.
        if (layoutFrameApplyObserver() === installedCheck) {
          observeLayoutFrameApply(previousCheck)
        }
        onStatus({ state: 'closed' })
      }
    }
  }
  return { ...actual, subscribeRuntimeLayout }
}
