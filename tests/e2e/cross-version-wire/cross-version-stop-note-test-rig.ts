import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, expect } from 'vitest'
import { StructuredAgentSessionHost } from '../../../src/main/native-chat/agent-session-wire/structured-agent-session-host'
import { NO_STRUCTURED_AGENTS } from '../../../src/main/native-chat/agent-session-wire/structured-agent-session-adapter-router-test-support'
import { setStructuredAgentSessionHost } from '../../../src/main/native-chat/agent-session-wire/structured-agent-session-registry'
import { createStructuredAgentSessionLogger } from '../../../src/main/native-chat/agent-session-wire/structured-agent-session-logger'
import { openTestAgentSessionRecordStore } from '../../../src/main/runtime/agent-session-record-store-test-harness'
import { openTestJournalHostDatabase } from '../../../src/main/native-chat/agent-session-journal/journal-host-database-test-support'
import type { AgentSessionJournal } from '../../../src/main/native-chat/agent-session-journal/journal-store'
import { agentJournalItemKey } from '../../../src/shared/agent-session-journal-item-key'
import { agentSessionFailureFact } from '../../../src/shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../src/shared/agent-session-failure-words'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody,
  type AgentJournalTurnLifecycle
} from '../../../src/shared/agent-session-journal-types'
import type {
  AgentSessionHistoryPage,
  AgentSessionHistoryResult,
  AgentSessionSubscribeEvent
} from '../../../src/shared/agent-session-wire'
import type { StructuredAgentSessionState } from '../../../src/shared/structured-agent-session-reducer'
import { codexProviderHandle } from '../../../src/shared/agent-session-provider-handle-encoding'
import {
  attachParams,
  NOW,
  resetOperationIds,
  SESSION,
  THREAD
} from './structured-agent-session-surface-manifest'
import {
  loadAgentSessionWireBuild,
  type AgentSessionClientProjection,
  type AgentSessionWireBuild,
  type RpcClientIdentity,
  type RpcReply
} from './versioned-agent-session-wire'

export type ScenarioPort = {
  build: () => AgentSessionWireBuild
  callBuild: (
    build: AgentSessionWireBuild,
    method: string,
    params: unknown,
    client: RpcClientIdentity,
    runtime?: unknown
  ) => Promise<RpcReply[]>
  runtimeStub: () => unknown
}
export const turnIdentity = { provider: 'orca', clientMessageId: 'turn-stop-test' } as const
export const turnItemId = agentJournalItemKey(turnIdentity)
export const noteIdentity = { provider: 'orca', clientMessageId: 'stop:turn-stop-test' } as const
export const noteId = agentJournalItemKey(noteIdentity)
export const scope = { kind: 'turn', turnItemId } as const
export const ordinary = { kind: 'status', text: 'Cancellation requested.' }
export const unconfirmed: AgentJournalItemBody = {
  kind: 'status',
  ...agentSessionFailureWords(agentSessionFailureFact('cancelUnconfirmed'), { surface: 'row' })
}

export function createReleasedStopNoteRig(port: ScenarioPort, ref: string) {
  let released: AgentSessionWireBuild
  let client: AgentSessionClientProjection
  let root: string
  let host: StructuredAgentSessionHost
  let journal: AgentSessionJournal
  beforeAll(async () => {
    released = await loadAgentSessionWireBuild(ref)
    client = await released.clientProjection()
  }, 180_000)
  beforeEach(async () => {
    resetOperationIds()
    root = await mkdtemp(join(tmpdir(), 'orca-released-stop-note-'))
    const store = await openTestAgentSessionRecordStore(root)
    host = new StructuredAgentSessionHost({
      agents: NO_STRUCTURED_AGENTS,
      store,
      journalDatabase: openTestJournalHostDatabase(root),
      claimKeyId: 'key-1',
      logger: createStructuredAgentSessionLogger(),
      now: () => NOW,
      adapter: {
        supportsCreate: () => true,
        acquire: async ({ fence, spawnToken }) => ({
          process: { hostId: 'local', pid: 4242, processStartTimeMs: NOW, spawnToken },
          link: {
            linkId: `link-${fence}`,
            handle: codexProviderHandle(THREAD),
            origin: 'created',
            mintedAtFence: fence,
            observedAt: NOW
          }
        }),
        dispatch: async () => ({ state: 'unknown', reason: 'unused' }),
        cancelTurn: async () => ({ cancelled: true }),
        answerPrompt: async () => {},
        setOption: async () => {}
      }
    })
    setStructuredAgentSessionHost(host)
    expect(await host.attach({ callerKey: 'released-client' }, attachParams(null))).toMatchObject({
      ok: true
    })
    journal = host['sessions'].get(SESSION)!.journal
  })
  afterEach(async () => {
    setStructuredAgentSessionHost(null)
    await host.flushAllStreamedEvents()
    await journal.close()
    await rm(root, { recursive: true, force: true })
  })
  function call(method: string, params: unknown) {
    return port.callBuild(
      port.build(),
      method,
      params,
      {
        clientKind: 'runtime',
        clientCapabilities: released.capabilities,
        clientId: 'released-client'
      },
      port.runtimeStub()
    )
  }
  async function page(params: Record<string, unknown>): Promise<AgentSessionHistoryPage> {
    const reply = (await call('agentSession.history', { sessionId: SESSION, ...params }))[0]
    expect(reply?.ok).toBe(true)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: real host history RPC answer; every item is admitted with the released client's schema below.
    const result = reply?.result as AgentSessionHistoryResult
    if (!result.ok) {
      throw new Error(result.reset)
    }
    return {
      ...result.page,
      items: result.page.items.map((item) => client.AgentJournalRenderItemSchema.parse(item))
    }
  }
  async function subscribe(cursor = journal.cursor()): Promise<RpcReply[]> {
    return call('agentSession.subscribe', { sessionId: SESSION, cursor })
  }
  function events(replies: RpcReply[]): AgentSessionSubscribeEvent[] {
    return replies.map((reply) => {
      expect(reply.ok).toBe(true)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: real streaming RPC reply; release admission validates each item before reduction.
      const event = reply.result as AgentSessionSubscribeEvent
      return event.type === 'batch'
        ? {
            ...event,
            batch: {
              ...event.batch,
              items: event.batch.items.map((item) =>
                client.AgentJournalRenderItemSchema.parse(item)
              )
            }
          }
        : event
    })
  }
  function reduce(state: StructuredAgentSessionState, replies: RpcReply[]) {
    return events(replies).reduce(
      (state, event) => client.reduceStructuredAgentSession(state, { type: 'event', event }),
      state
    )
  }
  function render(state: StructuredAgentSessionState) {
    const item = state.items.find((item) => item.itemId === noteId)!
    return client.projectStructuredItemsToNativeChat([item])[0]?.blocks[0]
  }
  async function turn(state: AgentJournalTurnLifecycle['state'], batch = false) {
    const body = { kind: 'turn' as const, turnId: 'turn-stop-test', state }
    await (batch
      ? journal.appendLifecycleBatch({
          settlementId: `end-${state}`,
          fence: 1,
          mutations: [
            { kind: 'item', identity: turnIdentity, body, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
          ]
        })
      : journal.appendItem(turnIdentity, body, { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }))
  }
  async function note(body: AgentJournalItemBody = unconfirmed) {
    await journal.appendItem(noteIdentity, body, { fence: 1, turnScope: scope })
  }
  async function seed() {
    await turn('running')
    await note()
    const initial = await page({ direction: 'tail' })
    return client.reduceStructuredAgentSession(client.EMPTY_STRUCTURED_AGENT_SESSION, {
      type: 'history-page',
      page: initial
    })
  }

  return {
    page,
    subscribe,
    events,
    reduce,
    render,
    turn,
    note,
    seed,
    get journal() {
      return journal
    },
    get client() {
      return client
    }
  }
}
