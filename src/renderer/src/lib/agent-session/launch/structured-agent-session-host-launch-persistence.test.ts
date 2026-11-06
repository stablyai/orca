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
import { markStructuredAgentSessionLaunchesPublished } from './structured-agent-session-launch-publication'
import { resetStructuredAgentLaunchRegistryForTests } from './structured-agent-session-launch-registry'
import { refuseDraftWrites } from './structured-agent-session-host-launch.test-fixture'
import { resetStructuredAgentLaunchPersistenceForTests } from './structured-agent-session-launch-persistence'
import { readNativeChatComposerDraft } from '@/components/native-chat/native-chat-composer-draft-store'
import { nativeChatComposerDraftStorage } from '@/components/native-chat/native-chat-composer-draft-storage'
import { structuredAgentSessionDraftScopeKey } from '@/components/native-chat/native-chat-composer-draft-store'
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
    prompt: { delivery: 'submit', outcome: 'journaled', messageId: MESSAGE_ID }
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
        opening: {
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
afterEach(() => {
  refuseDraftWrites(false)
  cleanupCreateMessageFixture(restore)
})

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
    refuseDraftWrites(true)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // The host refuses while nothing can be saved: the refusal still shows.
      status.resolve({ state: 'failed', code: 'agent_launch_setup_not_completed' })
      await launch.launchResult.catch(() => undefined)
      await vi.waitFor(() => expect(lifecycle()).toBe('failed'))
      await vi.runOnlyPendingTimersAsync()
    } finally {
      full.mockRestore()
      refuseDraftWrites(false)
      warn.mockRestore()
    }
    // Every word is back in front of the user, beside the separate draft...
    expect(draft(SESSION_ID)).toContain(HELD)
    expect(draft(SESSION_ID)).toContain('Also run lint')
    // ...but nothing claims the hand-back is durable: the launch and its saved row still hold it.
    expect(state.intent.opening?.clientMessageId).toBe(MESSAGE_ID)
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

describe('a rich opening its host never acknowledged', () => {
  const SKILL = { name: 'audit', path: '/skills/audit/SKILL.md' }
  const CLIENT = structuredAgentSessionSendBody(
    HELD,
    [{ path: '/client/shot.png', previewUri: '' }],
    [SKILL]
  )
  const ON_HOST = structuredAgentSessionSendBody(
    HELD,
    [{ path: '/host/shot.png', previewUri: '' }],
    [SKILL]
  )
  // Inside a work count, whose own spy is the one storage calls reach.
  const quota = () => {
    refuseDraftWrites(true)
    vi.mocked(localStorage.setItem).mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError')
    })
  }

  /** Ours, rich and released after Setup, beside `count - 1` held launches. */
  async function releasedRich(count: number, ending: Promise<AgentLaunchReleasePhaseStatusResult>) {
    mocks.exactSupport.mockResolvedValue(true)
    host.status.mockReset()
    host.release.mockReset()
    host.status.mockResolvedValueOnce({ state: 'awaiting-release' }).mockReturnValueOnce(ending)
    host.release.mockResolvedValue({ operationId: OPERATION_ID, state: 'running' })
    startLaunches(count)
    const launch = startStructuredAgentLaunch('workspace-1', 'codex', {
      requestId: newAgentLaunchRequestId(),
      executionHostId: 'local',
      prompt: HELD,
      draftFromScope: SOURCE_SCOPE,
      promptAttachments: [{ path: '/client/shot.png', previewUri: '' }],
      promptSkills: [SKILL],
      hostLaunch: {
        operationId: OPERATION_ID,
        sessionId: SESSION_ID,
        protocol: 'release',
        opening: { clientMessageId: MESSAGE_ID, body: CLIENT },
        stagedSources: ['/client/shot.png'],
        sources: { prepare: async () => ON_HOST, release: () => {} },
        accept: {
          presentation: 'focused',
          setupReceipt: { required: true, runId: 'setup-run-1' },
          terminalAlternative: { kind: 'none' }
        }
      }
    })
    await vi.waitFor(() => expect(host.release).toHaveBeenCalledOnce())
    return launch
  }

  it.each([3, 30])(
    'touches only its own row from release to receipt beside %i launches',
    async (count) => {
      const ending = Promise.withResolvers<AgentLaunchReleasePhaseStatusResult>()
      const launch = await releasedRich(count, ending.promise)
      const settled = await countWork(async () => {
        ending.resolve(CHAT_STARTED)
        await launch.launchResult
        await vi.runOnlyPendingTimersAsync()
      })
      expect(settled.preparedOthers).toBe(0)
      expect(settled.mutations).toBeLessThanOrEqual(3)
      expect(host.release).toHaveBeenCalledOnce()
      expect(savedRow()).toBeUndefined()
      expect(draft(SESSION_ID)).toBe('Also run lint')
    }
  )

  it.each([3, 30])(
    'keeps it through a chat the host already had, every publication and a reload, beside %i launches',
    async (count) => {
      const ending = Promise.withResolvers<AgentLaunchReleasePhaseStatusResult>()
      const launch = await releasedRich(count, ending.promise)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const refused = await countWork(async () => {
        quota()
        // The chat already exists on the host, which refuses this launch while nothing saves.
        ending.resolve({ state: 'failed', code: 'agent_launch_session_already_exists' })
        await launch.launchResult.catch(() => undefined)
        await vi.waitFor(() => expect(lifecycle()).toBe('failed'))
        await vi.runOnlyPendingTimersAsync()
      })
      expect(refused.preparedOthers).toBe(0)
      const held = { clientMessageId: MESSAGE_ID, body: ON_HOST }
      expect(getStructuredLaunchStateBySessionId(SESSION_ID)?.intent.opening).toEqual(held)
      expect(savedRow()).toMatchObject({ firstMessage: held })

      // Local and paired inventories list that existing chat: no receipt for this message.
      const reads = host.status.mock.calls.length
      host.status.mockResolvedValue({
        state: 'failed',
        code: 'agent_launch_session_already_exists'
      })
      const listed = await countWork(async () => {
        quota()
        markStructuredAgentSessionLaunchesPublished('local', [
          { worktreeId: 'workspace-1', sessionId: SESSION_ID }
        ])
        await vi.runOnlyPendingTimersAsync()
        await vi.waitFor(() => expect(host.status.mock.calls.length).toBeGreaterThan(reads))
        await vi.waitFor(() => expect(lifecycle()).toBe('failed'))
      })
      expect(listed.preparedOthers).toBe(0)
      expect(savedRow()).toMatchObject({ firstMessage: held })
      expect(lifecycle()).toBe('failed')
      // Another host listing a chat of that id says nothing about this launch.
      markStructuredAgentSessionLaunchesPublished('runtime:env-other', [
        { worktreeId: 'workspace-1', sessionId: SESSION_ID }
      ])
      expect(savedRow()).toMatchObject({ firstMessage: held })

      // A reload finds it saved still, as its last save could record it.
      refuseDraftWrites(false)
      resetStructuredAgentLaunchRegistryForTests()
      resetStructuredAgentLaunchPersistenceForTests()
      expect(savedRow()).toMatchObject({ firstMessage: held })

      // Once the composer can hold it, the next listing reads the launch, gives the whole message
      // back durably, and only then lets the row go.
      markStructuredAgentSessionLaunchesPublished('local', [
        { worktreeId: 'workspace-1', sessionId: SESSION_ID }
      ])
      await vi.waitFor(() => expect(savedRow()?.firstMessage).toBeUndefined())
      const back = readNativeChatComposerDraft(structuredAgentSessionDraftScopeKey(SESSION_ID))
      expect(back.text).toContain(HELD)
      expect(back.text).toContain('Also run lint')
      markStructuredAgentSessionLaunchesPublished('local', [
        { worktreeId: 'workspace-1', sessionId: SESSION_ID }
      ])
      await vi.waitFor(() => expect(savedRow()).toBeUndefined())
      warn.mockRestore()
      expect(host.release).toHaveBeenCalledOnce()
      expect(vi.mocked(callRuntimeRpc).mock.calls.map(([, method]) => method)).not.toContain(
        'agentSession.send'
      )
    }
  )

  describe('preparing and saving only what each step of its custody changes', () => {
    // Test-owned envelopes of the rows each necessary journal snapshot holds. Generated values
    // stand in at their fixed formats: a ms timestamp and uuid hex, a SHA-256 hex, a ms time.
    const OPERATION = `${'0'.repeat(13)}-${'0'.repeat(32)}`
    const FINGERPRINT = '0'.repeat(64)
    const FAILED_AT = 1_700_000_000_000
    const row = (sessionId: string, hostOperationId: string) => ({
      sessionId,
      executionHostId: 'local',
      agent: 'codex',
      clientOperationId: OPERATION,
      payloadFingerprint: FINGERPRINT,
      expectedRuntimeFence: null,
      hostLaunchOperationId: hostOperationId
    })
    const others = (count: number) =>
      Array.from({ length: count - 1 }, (_, index) => ({
        ...row(`codex_held_${count}_${index + 1}`, `${OPERATION_ID}-${index + 1}`),
        lifecycle: 'pending',
        firstMessage: {
          clientMessageId: `${MESSAGE_ID}-${index + 1}`,
          body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: HELD }] }
        }
      }))
    /** Ours as submitted after Setup: still holding its host-readable message or not, failed or not. */
    const ours = (held: boolean, failed: boolean) => ({
      ...row(SESSION_ID, OPERATION_ID),
      lifecycle: failed ? 'failed' : 'pending',
      hostLaunchFirstTurn: { phase: 'submitted', options: {}, selection: {} },
      ...(held
        ? {
            firstMessage: {
              clientMessageId: MESSAGE_ID,
              body: {
                kind: 'message',
                role: 'user',
                blocks: [
                  { type: 'text', text: HELD },
                  { type: 'image-ref', path: '/host/shot.png' }
                ]
              }
            }
          }
        : {}),
      ...(failed ? { failedAt: FAILED_AT } : {})
    })
    const snapshot = (count: number, own?: ReturnType<typeof ours>) =>
      JSON.stringify(own ? [...others(count), own] : others(count)).length

    // Test-owned envelopes of what the draft journal may hold for our returned message. The run
    // id is a ms timestamp and `Math.random()` as written, at most 24 chars; times are ms.
    const RUN = `${'0'.repeat(13)}-0.${'0'.repeat(22)}`
    const AT = 1_700_000_000_000
    const SCOPE = `agent-session:${SESSION_ID}`
    const RECEIPT = { operationId: OPERATION_ID, clientMessageId: MESSAGE_ID }
    const RETURNED_IMAGE = { id: `returned-${MESSAGE_ID}-1`, path: '/host/shot.png' }
    const paragraph = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] })
    /** The identified return of B, applied once by its receipt. */
    const addition = {
      scopeKey: SCOPE,
      at: AT,
      run: RUN,
      addition: { text: HELD, images: [RETURNED_IMAGE] },
      custody: { handback: RECEIPT, sourcePaths: [] }
    }
    /** The whole current draft, A then B, carrying B's receipt. */
    const current = {
      scopeKey: SCOPE,
      draft: {
        text: `Also run lint\n\n${HELD}`,
        document: {
          type: 'doc',
          content: [paragraph('Also run lint'), { type: 'paragraph' }, paragraph(HELD)]
        },
        images: [RETURNED_IMAGE],
        savedAt: AT,
        owner: { workspaceId: 'workspace-1', executionHostId: 'local' },
        handbacks: [RECEIPT]
      },
      at: AT,
      run: RUN
    }
    const journal = (entry: typeof addition | typeof current) => JSON.stringify([entry]).length
    const DRAFT_JOURNAL = 'orca:nativeChatComposerDraftJournal:v1'

    /** `countWork`, plus our own row preparations, the draft backend's commits of any kind and
     *  the draft journal's attempted writes and removals with their chars. */
    async function countOwnWork(run: () => Promise<void>) {
      const backend = nativeChatComposerDraftStorage()
      const commits = (['write', 'update', 'remove'] as const).map((method) =>
        vi.spyOn(backend, method)
      )
      const drafts = { draftCommits: 0, journalAttempts: 0, journalChars: 0 }
      try {
        const work = await countWork(async () => {
          await run()
          const journaled = vi
            .mocked(localStorage.setItem)
            .mock.calls.filter(([key]) => key === DRAFT_JOURNAL)
          const removed = vi
            .mocked(localStorage.removeItem)
            .mock.calls.filter(([key]) => key === DRAFT_JOURNAL)
          drafts.journalAttempts = journaled.length + removed.length
          drafts.journalChars = journaled.reduce((sum, [, value]) => sum + value.length, 0)
        })
        drafts.draftCommits = commits.reduce((sum, spy) => sum + spy.mock.calls.length, 0)
        const own = vi
          .mocked(structuredAgentLaunchRecordFor)
          .mock.calls.filter(([intent]) => intent.sessionId === SESSION_ID).length
        return { ...work, ...drafts, own }
      } finally {
        commits.forEach((spy) => spy.mockRestore())
      }
    }

    it.each([3, 30])('from receipt to a shown chat beside %i launches', async (count) => {
      const ending = Promise.withResolvers<AgentLaunchReleasePhaseStatusResult>()
      const launch = await releasedRich(count, ending.promise)
      const work = await countOwnWork(async () => {
        ending.resolve(CHAT_STARTED)
        await launch.launchResult
        await vi.runOnlyPendingTimersAsync()
      })
      expect(savedRow()).toBeUndefined()
      expect(draft(SESSION_ID)).toBe('Also run lint')
      // The receipt ends custody (the message leaves our row), the launch settles (our row
      // saved once more), and the shown chat removes the row: two preparations of ours, three
      // journal writes of N, N and N-1 rows, and a few status publications, none per launch.
      expect(work).toMatchObject({ preparedOthers: 0 })
      expect(work.own).toBeLessThanOrEqual(2)
      expect(work.mutations).toBeLessThanOrEqual(3)
      expect(work.published).toBeLessThanOrEqual(4)
      expect(work.savedRows).toBeLessThanOrEqual(3 * count - 1)
      const released = ours(false, false)
      expect(work.savedBytes).toBeLessThanOrEqual(2 * snapshot(count, released) + snapshot(count))
      // The host took the message: nothing returns to the composer.
      expect(work).toMatchObject({ draftCommits: 0, journalAttempts: 0 })
    })

    it.each([3, 30])(
      'through a refusal and the publications that re-read it beside %i launches',
      async (count) => {
        const ending = Promise.withResolvers<AgentLaunchReleasePhaseStatusResult>()
        const launch = await releasedRich(count, ending.promise)
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const refused = await countOwnWork(async () => {
          quota()
          ending.resolve({ state: 'failed', code: 'agent_launch_session_already_exists' })
          await launch.launchResult.catch(() => undefined)
          await vi.waitFor(() => expect(lifecycle()).toBe('failed'))
          await vi.runOnlyPendingTimersAsync()
        })
        // The refusal is one transition: our row, failed and still holding its message, one
        // attempted write of all N rows that storage refuses.
        expect(refused).toMatchObject({ preparedOthers: 0 })
        expect(refused.own).toBeLessThanOrEqual(1)
        expect(refused.mutations).toBeLessThanOrEqual(1)
        expect(refused.published).toBeLessThanOrEqual(1)
        expect(refused.savedRows).toBeLessThanOrEqual(count)
        expect(refused.savedBytes).toBeLessThanOrEqual(snapshot(count, ours(true, true)))
        // B returns to the composer once: one commit of the current draft, which refuses, and
        // two journal attempts, the identified addition then the current draft as fallback.
        expect(refused.draftCommits).toBeLessThanOrEqual(1)
        expect(refused.journalAttempts).toBeLessThanOrEqual(2)
        expect(refused.journalChars).toBeLessThanOrEqual(journal(addition) + journal(current))

        const reads = host.status.mock.calls.length
        host.status.mockResolvedValue({
          state: 'failed',
          code: 'agent_launch_session_already_exists'
        })
        const listed = await countOwnWork(async () => {
          quota()
          markStructuredAgentSessionLaunchesPublished('local', [
            { worktreeId: 'workspace-1', sessionId: SESSION_ID }
          ])
          await vi.runOnlyPendingTimersAsync()
          await vi.waitFor(() => expect(host.status.mock.calls.length).toBeGreaterThan(reads))
          await vi.waitFor(() => expect(lifecycle()).toBe('failed'))
        })
        warn.mockRestore()
        // Its own host listing the chat re-reads the launch (pending again, message held), the
        // read settles (saved again, message held) and the failure shows again (failed, message
        // still held: the refused draft adoption never clears our row). Three own steps, each
        // one attempted write of N rows and one publication, all refused by storage.
        expect(listed).toMatchObject({ preparedOthers: 0 })
        expect(listed.own).toBeLessThanOrEqual(3)
        expect(listed.mutations).toBeLessThanOrEqual(3)
        expect(listed.published).toBeLessThanOrEqual(3)
        expect(listed.savedRows).toBeLessThanOrEqual(3 * count)
        expect(listed.savedBytes).toBeLessThanOrEqual(
          2 * snapshot(count, ours(true, false)) + snapshot(count, ours(true, true))
        )
        // The composer already shows B by its receipt: only the current draft is retried, once
        // in the backend and once as journal fallback, never B again.
        expect(listed.draftCommits).toBeLessThanOrEqual(1)
        expect(listed.journalAttempts).toBeLessThanOrEqual(1)
        expect(listed.journalChars).toBeLessThanOrEqual(journal(current))
        expect(savedRow()).toMatchObject({ firstMessage: { clientMessageId: MESSAGE_ID } })
      }
    )
  })
})
