// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  mocks,
  resetCreateMessageFixture,
  cleanupCreateMessageFixture,
  draft,
  target
} from '../../structured-agent-session-launch-create-message.test-fixture'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { startStructuredAgentLaunch } from './structured-agent-session-launch'
import {
  getStructuredAgentSessionLaunchLifecycle,
  getStructuredLaunchStateBySessionId,
  notifyStructuredLaunchStateChanged,
  subscribeStructuredAgentLaunchStatus,
  type StructuredLaunchState
} from './structured-agent-session-launch-registry'
import { releaseHostLaunchMessage } from './structured-agent-session-host-launch-custody'
import { markStructuredAgentSessionLaunchCancelledSilently } from './structured-agent-session-launch-cancel'
import { holdStructuredAgentSessionLaunchOption } from './structured-agent-session-launch-options'
import { newAgentLaunchRequestId } from '../../agent-launch-request-id'
import { updateNativeChatComposerDraft } from '@/components/native-chat/native-chat-composer-draft-store'
import { recordHostModelCatalogSnapshot } from '@/runtime/host-model-catalog-snapshots'
import { forgetStructuredSessionSelection } from '../../structured-agent-session-selection-controller'
import type {
  AgentLaunchReleasePhaseStatusResult,
  AgentLaunchStatusResult
} from '../../../../../shared/rpc-contract/agent-launch-accept-params'
import type { AgentSessionHistoryPage } from '../../../../../shared/agent-session/agent-session-wire'
import { structuredAgentSessionSendBody } from '../../../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import { structuredAgentLaunchRecordFor } from './structured-agent-session-launch-record'
import type * as recordModule from './structured-agent-session-launch-record'

// Counts each launch row this window prepares for saving, by the launch it describes.
vi.mock('./structured-agent-session-launch-record', async (original) => {
  const record = await original<typeof recordModule>()
  return { ...record, structuredAgentLaunchRecordFor: vi.fn(record.structuredAgentLaunchRecordFor) }
})

const SAVED = 'orca:structuredAgentLaunches:v1'
const OPERATION_ID = `${Date.now()}-000000000000000000000000000000ac`
const SESSION_ID = 'codex_9b1deb4d_3b7d_4bad_9bdd_2b0d7b3dcb6d'
const MESSAGE_ID = `${Date.now()}-000000000000000000000000000000ae`
const HELD = 'Inspect the failing test and fix it'
const SOURCE_SCOPE = 'pending-worktree-creation:creation-1'
const CHAT_STARTED: AgentLaunchStatusResult = {
  state: 'succeeded',
  result: {
    outcome: { kind: 'structured', sessionId: SESSION_ID, handle: 'chat' },
    worktreeId: 'workspace-1',
    receipt: { mode: 'structured', preferred: 'structured', reason: 'user_default', detail: '' },
    prompt: { delivery: 'submit', outcome: 'journaled', messageId: 'host-message' }
  }
}

const host = vi.hoisted(() => ({
  status: vi.fn<(params: unknown) => Promise<AgentLaunchReleasePhaseStatusResult>>(),
  release: vi.fn<(params: unknown) => Promise<unknown>>()
}))

/** The launch under test is accepted and read; every other launch's accept is still held. */
function hostAnswers(): void {
  vi.mocked(callRuntimeRpc).mockImplementation(async (_target, method, params) => {
    const ours = (params as { operationId?: string }).operationId === OPERATION_ID
    if (method === 'agent.launchAccept' || method === 'agent.launchPrepare') {
      return ours ? { operationId: OPERATION_ID, state: 'running' } : new Promise(() => {})
    }
    if (method === 'agent.launchStatus') {
      return host.status(params)
    }
    return method === 'agent.launchRelease' ? host.release(params) : {}
  })
}

function hostHistory() {
  const cursor = { epoch: 'epoch-1', sequence: 1 }
  const page: AgentSessionHistoryPage = {
    sessionId: SESSION_ID,
    epoch: cursor.epoch,
    fence: 3,
    direction: 'tail',
    items: [],
    removedItemIds: [],
    submissions: [],
    window: { oldest: null, newest: null, nextCursor: cursor },
    liveCursor: cursor,
    hasOlder: false,
    hasNewer: false,
    latestTurn: null
  }
  return { ok: true, page }
}

/** Starts host launches holding their first messages: `count - 1` still waiting on their hosts,
 *  then ours in workspace-1, released after Setup when `release`. */
function startLaunches(count: number, release = false) {
  const start = (index: number) => {
    const ours = index === 0
    const sessionId = ours ? SESSION_ID : `codex_held_${count}_${index}`
    const messageId = ours ? MESSAGE_ID : `${MESSAGE_ID}-${index}`
    return startStructuredAgentLaunch(ours ? 'workspace-1' : `workspace-${index + 1}`, 'codex', {
      requestId: newAgentLaunchRequestId(),
      executionHostId: 'local',
      ...(ours ? { prompt: HELD, draftFromScope: SOURCE_SCOPE } : {}),
      hostLaunch: {
        operationId: ours ? OPERATION_ID : `${OPERATION_ID}-${index}`,
        sessionId,
        ...(release && ours ? { protocol: 'release' as const } : {}),
        firstMessage: {
          clientMessageId: messageId,
          body: structuredAgentSessionSendBody(HELD, [])
        },
        accept: {
          prompt: { text: HELD, clientMessageId: messageId },
          presentation: 'focused' as const,
          setupReceipt: { required: true as const, runId: 'setup-run-1' },
          ...(release && ours ? { terminalAlternative: { kind: 'agent', prompt: 'none' } } : {})
        }
      }
    } as Parameters<typeof startStructuredAgentLaunch>[2])
  }
  for (let index = 1; index < count; index++) {
    start(index)
  }
  return { ours: () => start(0) }
}

type Work = { mutations: number; savedRows: number; savedBytes: number; preparedOthers: number }

/** The saving and publishing `run` causes: journal writes and removals, the rows and bytes they
 *  hold, rows prepared for launches other than ours, and status listener callbacks. */
async function countWork(run: () => Promise<void> | void): Promise<Work & { published: number }> {
  const prepared = vi.mocked(structuredAgentLaunchRecordFor)
  prepared.mockClear()
  let published = 0
  const unsubscribe = subscribeStructuredAgentLaunchStatus(() => published++)
  const set = vi.spyOn(localStorage, 'setItem')
  const remove = vi.spyOn(localStorage, 'removeItem')
  try {
    await run()
    const writes = set.mock.calls.filter(([key]) => key === SAVED)
    return {
      mutations: writes.length + remove.mock.calls.filter(([key]) => key === SAVED).length,
      savedRows: writes.reduce((sum, [, value]) => sum + JSON.parse(value).length, 0),
      savedBytes: writes.reduce((sum, [, value]) => sum + value.length, 0),
      preparedOthers: prepared.mock.calls.filter(([intent]) => intent.sessionId !== SESSION_ID)
        .length,
      published
    }
  } finally {
    unsubscribe()
    set.mockRestore()
    remove.mockRestore()
  }
}

const savedRow = (): Record<string, unknown> | undefined =>
  (JSON.parse(localStorage.getItem(SAVED) ?? '[]') as Record<string, unknown>[]).find(
    (row) => row.sessionId === SESSION_ID
  )
const lifecycle = () => getStructuredAgentSessionLaunchLifecycle('workspace-1', SESSION_ID)

let restore: (() => void) | undefined
beforeEach(() => {
  restore = resetCreateMessageFixture()
  hostAnswers()
  mocks.call.mockResolvedValue(hostHistory())
  updateNativeChatComposerDraft(SOURCE_SCOPE, { text: 'Also run lint', images: [] }, 'immediate')
})
afterEach(() => cleanupCreateMessageFixture(restore))

describe('one host launch settling beside many others', () => {
  it.each([
    ['takes the first message as its chat', CHAT_STARTED, null],
    ['refuses it', { state: 'failed', code: 'agent_launch_setup_not_completed' }, 'failed'],
    ['cannot say', { state: 'unknown' }, 'visibility-unknown']
  ] as const)('saves only its own row when its host %s', async (_case, answer, after) => {
    const costs: Work[] = []
    for (const count of [3, 30]) {
      cleanupCreateMessageFixture(restore)
      restore = resetCreateMessageFixture()
      hostAnswers()
      mocks.call.mockResolvedValue(hostHistory())
      updateNativeChatComposerDraft(
        SOURCE_SCOPE,
        { text: 'Also run lint', images: [] },
        'immediate'
      )
      const status = Promise.withResolvers<AgentLaunchReleasePhaseStatusResult>()
      host.status.mockReturnValueOnce(status.promise)
      const launch = startLaunches(count).ours()
      await vi.waitFor(() => expect(host.status).toHaveBeenCalledOnce())
      const state = getStructuredLaunchStateBySessionId(SESSION_ID)!
      expect(savedRow()).toMatchObject({ firstMessage: { clientMessageId: MESSAGE_ID } })

      // The host's receipt, then every settlement and visibility callback it sets off.
      const work = await countWork(async () => {
        status.resolve(answer)
        await launch.launchResult.catch(() => undefined)
        await vi.waitFor(() => expect(lifecycle()).toBe(after))
        await vi.runOnlyPendingTimersAsync()
      })
      // No other launch's row is prepared, and each write is a constant few of the journal.
      expect(work.preparedOthers).toBe(0)
      costs.push(work)
      expect(savedRow()?.firstMessage).toBeUndefined()
      // The text is the host's now or back with the user; the separate draft is never lost.
      expect(draft(SESSION_ID)).toContain('Also run lint')
      expect(draft(SESSION_ID).includes(HELD)).toBe(answer !== CHAT_STARTED)

      // A repeated receipt, and a callback for a launch already retired or replaced, save nothing.
      const late = await countWork(() => {
        releaseHostLaunchMessage(state.intent, true)
        notifyStructuredLaunchStateChanged({ ...state } as StructuredLaunchState)
      })
      expect(late).toMatchObject({ mutations: 0, preparedOthers: 0 })
      if (after === null) {
        notifyStructuredLaunchStateChanged(state)
        expect(savedRow()).toBeUndefined()
      }
    }
    const [small, large] = costs as [Work, Work]
    // The same number of writes whatever the number of launches, each linear in the journal.
    expect(large.mutations).toBe(small.mutations)
    expect(large.savedRows).toBeLessThanOrEqual(large.mutations * 30)
  })

  it('saves only its own row as its first turn is edited and submitted after Setup', async () => {
    mocks.exactSupport.mockResolvedValue(true)
    forgetStructuredSessionSelection(SESSION_ID)
    const efforts = [
      { value: 'low', label: 'Low' },
      { value: 'high', label: 'High' }
    ]
    recordHostModelCatalogSnapshot(target, 'codex', null, {
      origin: 'probe',
      fetchedAt: 1,
      defaultHoldsInEveryWorkspace: true,
      models: [
        { id: 'shown-model', label: 'Shown', isDefault: true, efforts },
        { id: 'picked-model', label: 'Picked', isDefault: false, efforts }
      ]
    })
    const setup = Promise.withResolvers<AgentLaunchReleasePhaseStatusResult>()
    host.status.mockReturnValueOnce(setup.promise).mockReturnValue(new Promise(() => {}))
    host.release.mockResolvedValue({ operationId: OPERATION_ID, state: 'running' })
    const launches = startLaunches(30, true)
    const editing = await countWork(async () => {
      launches.ours()
      await vi.waitFor(() => expect(host.status).toHaveBeenCalledOnce())
    })
    expect(savedRow()).toMatchObject({ hostLaunchFirstTurn: { phase: 'editing' } })
    void holdStructuredAgentSessionLaunchOption(SESSION_ID, 'model', 'picked-model')

    const submitted = await countWork(async () => {
      setup.resolve({ state: 'awaiting-release' })
      await vi.waitFor(() => expect(host.release).toHaveBeenCalledOnce())
    })
    expect(savedRow()).toMatchObject({
      hostLaunchFirstTurn: { phase: 'submitted', selection: { model: 'picked-model' } }
    })
    // Beside 29 other launches, its start, shown first turn and submission touch only its row.
    expect(editing.preparedOthers).toBe(0)
    expect(submitted).toMatchObject({ mutations: 1, savedRows: 30, preparedOthers: 0 })
  })

  it('keeps custody saved when the composer cannot durably take the message back', async () => {
    const status = Promise.withResolvers<AgentLaunchReleasePhaseStatusResult>()
    host.status.mockReturnValueOnce(status.promise)
    const launch = startLaunches(3).ours()
    await vi.waitFor(() => expect(host.status).toHaveBeenCalledOnce())
    const state = getStructuredLaunchStateBySessionId(SESSION_ID)!
    const full = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // The host refuses while nothing can be saved: the refusal still shows.
      status.resolve({ state: 'failed', code: 'agent_launch_setup_not_completed' })
      await launch.launchResult.catch(() => undefined)
      await vi.waitFor(() => expect(lifecycle()).toBe('failed'))
      await vi.runOnlyPendingTimersAsync()
    } finally {
      full.mockRestore()
      warn.mockRestore()
    }
    // Every word is back in front of the user, beside the separate draft...
    expect(draft(SESSION_ID)).toContain(HELD)
    expect(draft(SESSION_ID)).toContain('Also run lint')
    // ...but nothing claims the hand-back is durable: the launch and its saved row still hold it.
    expect(state.intent.hostLaunch?.firstMessage?.clientMessageId).toBe(MESSAGE_ID)
    expect(savedRow()).toMatchObject({ firstMessage: { clientMessageId: MESSAGE_ID } })

    // Dismissed once storage works: a late callback for it restores no row.
    markStructuredAgentSessionLaunchCancelledSilently('workspace-1', SESSION_ID, 'local')
    expect(savedRow()).toBeUndefined()
    const late = await countWork(() => {
      releaseHostLaunchMessage(state.intent, false)
      notifyStructuredLaunchStateChanged(state)
    })
    expect(late).toMatchObject({ mutations: 0, preparedOthers: 0 })
    expect(savedRow()).toBeUndefined()
  })
})
