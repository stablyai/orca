// @vitest-environment happy-dom

import '../../src/main/runtime/rpc/unused-default-rpc-methods.test-fixture'
import '@testing-library/jest-dom/vitest'
import { createElement } from 'react'
import { cleanup, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
  type AgentJournalCursor,
  type AgentJournalMessageItem
} from '../../src/shared/agent-session-journal-types'
import { AGENT_SESSION_CURRENT_REQUESTS_CLIENT_CAPABILITY } from '../../src/shared/agent-session-current-requests-capability'
import {
  AGENT_SESSION_HISTORY_MAX_LIMIT,
  type AgentSessionHistoryRequest,
  type AgentSessionHistoryResult,
  type AgentSessionSubscribeEvent
} from '../../src/shared/agent-session-wire'
import { MOBILE_BRIDGE_MAX_FRAME_BYTES } from '../../src/shared/mobile-bridge-frame-bytes'
import {
  AGENT_SESSION_SNAPSHOT_CATCH_UP_CLIENT_CAPABILITY,
  AGENT_SESSION_TURN_ITEM_CAPABILITY
} from '../../src/shared/protocol-version'
import type { RuntimeRpcResponse } from '../../src/shared/runtime-rpc-envelope'
import { withNativeChatCutTurnNotices } from '../../src/shared/native-chat/transcript/native-chat-cut-turn-notice'
import { nativeChatRowsInDrawOrder } from '../../src/shared/native-chat/transcript/native-chat-turn-grouping'
import { nativeChatTurnMembership } from '../../src/shared/native-chat-turn-membership'
import { projectStructuredAgentSessionMessages } from '../../src/shared/structured-agent-session-message-projection'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  oldestStructuredAgentSessionCursor,
  reduceStructuredAgentSession,
  type StructuredAgentSessionState
} from '../../src/shared/structured-agent-session-reducer'
import { selectStructuredAgentSettledTurns } from '../../src/shared/structured-agent-session-turn-timing'
import { openTestJournalHostDatabase } from '../../src/main/native-chat/agent-session-journal/journal-host-database-test-support'
import { restoreJournal } from '../../src/main/native-chat/agent-session-journal/journal-open'
import { journalOutcomeSource } from '../../src/main/native-chat/agent-session-journal/journal-outcome-format'
import { prepareJournalOutcomeWrite } from '../../src/main/native-chat/agent-session-journal/journal-outcome-write'
import type { JournalRow } from '../../src/main/native-chat/agent-session-journal/journal-row-schema'
import { hostTestAttachParams } from '../../src/main/native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { seedQueuedRigLegacyJournal } from '../../src/main/native-chat/agent-session-wire/structured-agent-session-queued-legacy-journal.test-fixture'
import {
  createRestTestRig,
  REST_TEST_CALLER,
  REST_TEST_SESSION as SESSION,
  type RestTestRig
} from '../../src/main/native-chat/agent-session-wire/structured-agent-session-rest-test-rig'
import { setStructuredAgentSessionHost } from '../../src/main/native-chat/agent-session-wire/structured-agent-session-registry'
import { OrcaRuntimeService } from '../../src/main/runtime/orca-runtime'
import { RpcDispatcher } from '../../src/main/runtime/rpc/dispatcher'
import { STRUCTURED_AGENT_SESSION_METHODS } from '../../src/main/runtime/rpc/methods/structured-agent-session'
import {
  STRUCTURED_CLIENT,
  STRUCTURED_MOBILE_CLIENT
} from '../../src/main/runtime/rpc/methods/structured-agent-session-rpc-client.test-fixture'
import { MAX_TIMER_DELAY_MS } from '../../src/shared/timer-delay'
import {
  buildMobileNativeChatTransientData,
  foldMobileNativeChatMessages
} from '../../mobile/src/session/mobile-native-chat-render-data'
import { NativeChatMessageList } from '../../src/renderer/src/components/native-chat/NativeChatMessageList'
import { render } from '../../src/renderer/src/components/native-chat/native-chat-tooltip-test-harness'
import { installNativeChatMessageListTestViewport } from '../../src/renderer/src/components/native-chat/native-chat-message-list-test-viewport'

vi.mock('../../src/renderer/src/components/native-chat/NativeChatInlineVisual', () => ({
  NativeChatInlineVisual: () => {
    throw new Error('Unexpected inline visual')
  }
}))
vi.mock('@/lib/open-agent-message-sender', () => ({
  openAgentMessageSender: () => {
    throw new Error('Unexpected sender navigation')
  }
}))

const PROMPT = 'Keep the original question after restart'
const STALE = 'Saved answer before revision'
const ANSWER = 'Completed answer after restore'
const REMOVED = 'Disposable status before restart'
const OLDER = 'The earlier question'
const OLDER_ANSWER = 'The earlier completed answer'
const PUBLISHED = 'Published after restore'
const currentDesktop = {
  ...STRUCTURED_CLIENT,
  clientCapabilities: [
    ...STRUCTURED_CLIENT.clientCapabilities,
    AGENT_SESSION_SNAPSHOT_CATCH_UP_CLIENT_CAPABILITY,
    AGENT_SESSION_CURRENT_REQUESTS_CLIENT_CAPABILITY,
    AGENT_SESSION_TURN_ITEM_CAPABILITY
  ]
}
const clients = [
  ['bounded phone', STRUCTURED_MOBILE_CLIENT, true, true],
  ['current paired desktop', currentDesktop, false, true],
  ['legacy paired desktop', STRUCTURED_CLIENT, false, false]
] as const
// A new chat holds only records; an existing (mixed) chat holds old input rows up to the restart
// and records after its marker, so catch-up from a cursor inside the old rows crosses into records.
const cases = (['new', 'mixed'] as const).flatMap((kind) =>
  clients.map(
    ([name, client, bounded, snapshotCatchUp]) =>
      [kind, name, client, bounded, snapshotCatchUp] as const
  )
)
const message = (
  text: string,
  role: 'user' | 'assistant' = 'assistant'
): AgentJournalMessageItem => ({
  kind: 'message',
  role,
  blocks: [{ type: 'text', text }]
})
let rig: RestTestRig | undefined
let controllers: AbortController[] = []
let restoreViewport = () => {}
beforeAll(() => {
  restoreViewport = installNativeChatMessageListTestViewport()
})
afterAll(() => restoreViewport())
afterEach(async () => {
  cleanup()
  for (const controller of controllers) {
    controller.abort()
  }
  controllers = []
  setStructuredAgentSessionHost(null)
  await rig?.dispose()
  rig = undefined
  vi.restoreAllMocks()
})

function desktop(state: StructuredAgentSessionState): void {
  render(
    createElement(NativeChatMessageList, {
      session: {
        messages: projectStructuredAgentSessionMessages(state.items, [], state.submissions),
        status: 'ready',
        sessionId: SESSION,
        agent: 'codex',
        hasMore: state.hasOlder,
        loadingEarlier: false,
        olderHistoryGeneration: 1,
        loadEarlier: vi.fn(),
        readPhase: 'ready'
      },
      journalItems: state.items,
      journalSubmissions: state.submissions,
      settledTurns: selectStructuredAgentSettledTurns(state.items, state.submissions),
      isWorking: false,
      workingStartedAt: null,
      expandSignal: false
    })
  )
  const ordered = [OLDER, OLDER_ANSWER, PROMPT, ANSWER, PUBLISHED].map((text) => {
    expect(screen.getAllByText(text)).toHaveLength(1)
    return screen.getByText(text)
  })
  expect(screen.queryByText(STALE)).toBeNull()
  expect(screen.queryByText(REMOVED)).toBeNull()
  let previous: HTMLElement | undefined
  for (const row of ordered) {
    if (previous) {
      expect(previous.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    }
    previous = row
  }
  cleanup()
}

function phone(state: StructuredAgentSessionState): void {
  const items = withNativeChatCutTurnNotices(state.items, { agentName: 'Codex' })
  const messages = projectStructuredAgentSessionMessages(items, [], state.submissions)
  const folded = foldMobileNativeChatMessages(messages, 'codex')
  const { data } = buildMobileNativeChatTransientData({ folded, streaming: null, pending: [] })
  const membership = nativeChatTurnMembership(data, { items, submissions: state.submissions })
  const rows = nativeChatRowsInDrawOrder(data, membership.drawOrder)
  const displayed = rows.flatMap((row) =>
    row.blocks.flatMap((block) =>
      block.type === 'text' ? [{ role: row.role, text: block.text }] : []
    )
  )
  const expected = [
    { role: 'user', text: OLDER },
    { role: 'assistant', text: OLDER_ANSWER },
    { role: 'user', text: PROMPT },
    { role: 'assistant', text: ANSWER },
    { role: 'assistant', text: PUBLISHED }
  ]
  expect(displayed.filter((row) => expected.some((target) => target.text === row.text))).toEqual(
    expected
  )
  expect(displayed.some((row) => row.text === STALE || row.text === REMOVED)).toBe(false)
}

it.each(cases)(
  'draws a restored %s chat, prefix and tail, through %s history and subscriber delivery',
  async (kind, _name, client, bounded, snapshotCatchUp) => {
    const active = await createRestTestRig({ idleSweep: { intervalMs: MAX_TIMER_DELAY_MS } })
    rig = active
    setStructuredAgentSessionHost(active.host)
    const pinInputs = kind === 'mixed' ? seedQueuedRigLegacyJournal(active.root, SESSION) : null
    const attached = await active.host.attach(REST_TEST_CALLER, hostTestAttachParams(null))
    if (!attached.ok) {
      throw new Error('Fixture attach refused')
    }
    pinInputs?.(active.host)
    const journal = active.host.collaboratorsForTests().sessions.get(SESSION)?.journal
    if (!journal) {
      throw new Error('Fixture journal absent')
    }
    const options = { fence: attached.fence, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    const dispatcher = new RpcDispatcher({
      runtime: new OrcaRuntimeService(),
      methods: STRUCTURED_AGENT_SESSION_METHODS
    })
    let requestId = 0
    async function history(request: Omit<AgentSessionHistoryRequest, 'sessionId'>) {
      const frame: RuntimeRpcResponse<AgentSessionHistoryResult> = JSON.parse(
        JSON.stringify(
          await dispatcher.dispatch(
            {
              id: `history-${++requestId}`,
              authToken: 'token',
              method: 'agentSession.history',
              params: { sessionId: SESSION, ...request }
            },
            client
          )
        )
      )
      if (!frame.ok) {
        throw new Error(`History RPC failed: ${frame.error.code}`)
      }
      if (!frame.result.ok) {
        throw new Error(`History reset: ${frame.result.reset}`)
      }
      return frame.result.page
    }
    const append = journal.appendItem.bind(journal)
    async function completedTurn(id: string, prompt: string, answer: string) {
      const user = await append(
        { provider: 'orca', clientMessageId: `${id}-user` },
        message(prompt, 'user'),
        options
      )
      const turn = await append(
        { provider: 'orca', clientMessageId: `${id}-turn` },
        {
          kind: 'turn',
          turnId: id,
          userItemId: user.itemId,
          state: 'completed',
          outcome: 'success',
          startedAt: active.clock.now - 2_000,
          completedAt: active.clock.now - 1_000
        },
        options
      )
      const turnScope = { kind: 'turn', turnItemId: turn.itemId } as const
      const response = await append(
        { provider: 'orca', clientMessageId: `${id}-answer` },
        message(answer),
        { ...options, turnScope }
      )
      return { response, turnScope }
    }
    await completedTurn('older', OLDER, OLDER_ANSWER)
    for (let index = 0; index < AGENT_SESSION_HISTORY_MAX_LIMIT; index += 1) {
      await journal.appendItem(
        { provider: 'orca', clientMessageId: `context-${index}` },
        message(`Context ${index}`),
        options
      )
    }
    // The mixed reader resumes from here, inside the old rows.
    const crossing = kind === 'mixed' ? await history({ direction: 'tail' }) : null
    const { response, turnScope } = await completedTurn('current', PROMPT, STALE)
    const disposable = await journal.appendItem(
      { provider: 'orca', clientMessageId: 'disposable' },
      { kind: 'status', text: REMOVED },
      options
    )
    const prefixPage = await history({ direction: 'tail' })
    expect(prefixPage.hasOlder).toBe(true)
    expect(JSON.stringify(prefixPage.items)).toContain(STALE)
    expect(JSON.stringify(prefixPage.items)).toContain(REMOVED)
    expect(JSON.stringify(prefixPage.items)).not.toContain(OLDER)
    const resumeFrom = crossing ?? prefixPage
    const resumeCursor = resumeFrom.liveCursor
    if (!resumeCursor) {
      throw new Error('Missing pre-close history cursor')
    }
    await active.host.close(SESSION, 'evict')
    expect(active.host.hasSession(SESSION)).toBe(false)
    const database = openTestJournalHostDatabase(active.root)
    const saved = restoreJournal(database.db, SESSION)?.state
    if (!saved) {
      throw new Error('Missing usable projection before tail append')
    }
    const prefix = { epoch: saved.epoch, sequence: saved.lastSequence }
    expect(prefix.sequence).toBeGreaterThanOrEqual(resumeCursor.sequence)
    database.transaction(
      (db) => {
        const rows: JournalRow[] = []
        for (let offset = 1; offset <= AGENT_SESSION_HISTORY_MAX_LIMIT; offset += 1) {
          rows.push({
            v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
            epoch: prefix.epoch,
            seq: prefix.sequence + offset,
            fence: attached.fence,
            ts: active.clock.now + offset,
            kind: 'item',
            itemId: response.itemId,
            revision: response.revision + offset,
            body: message(
              offset === AGENT_SESSION_HISTORY_MAX_LIMIT ? ANSWER : `Answer revision ${offset}`
            ),
            turnScope
          })
        }
        rows.push({
          v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
          epoch: prefix.epoch,
          seq: prefix.sequence + AGENT_SESSION_HISTORY_MAX_LIMIT + 1,
          fence: attached.fence,
          ts: active.clock.now + AGENT_SESSION_HISTORY_MAX_LIMIT + 1,
          kind: 'tombstone',
          itemId: disposable.itemId,
          revision: disposable.revision + 1
        })
        return prepareJournalOutcomeWrite(db, saved, rows, active.clock.now)
      },
      false,
      (result) => {
        result.adopt()
      }
    )
    // Anti-vacuous: the mixed chat's rows end at the restart and its records follow the marker.
    expect(journalOutcomeSource(database.db, SESSION, prefix.epoch)?.prefix).toBe(
      kind === 'mixed' ? prefix.sequence : 0
    )
    const restoredPage = await history({ direction: 'tail' })
    expect(restoredPage.liveCursor?.sequence).toBeGreaterThan(prefix.sequence)
    expect(active.adapter.acquire).toHaveBeenCalledTimes(1)
    const subscribe = vi.spyOn(active.host, 'subscribe')
    async function stream(cursor?: AgentJournalCursor) {
      const events: AgentSessionSubscribeEvent[] = []
      const rawFrames: string[] = []
      const controller = new AbortController()
      controllers.push(controller)
      await dispatcher.dispatchStreaming(
        {
          id: `stream-${++requestId}`,
          authToken: 'token',
          method: 'agentSession.subscribe',
          params: { sessionId: SESSION, ...(cursor ? { cursor } : {}) }
        },
        (raw) => {
          const frame: RuntimeRpcResponse<AgentSessionSubscribeEvent> = JSON.parse(raw)
          if (!frame.ok) {
            throw new Error(`Subscription RPC failed: ${frame.error.code}`)
          }
          rawFrames.push(raw)
          events.push(frame.result)
        },
        {
          ...client,
          clientId: 'client-1',
          connectionId: 'restored-reader',
          signal: controller.signal
        }
      )
      expect(subscribe).toHaveBeenLastCalledWith(expect.objectContaining({ snapshotCatchUp }))
      expect(subscribe.mock.calls.at(-1)?.[0].boundedFrames === true).toBe(bounded)
      return { events, rawFrames }
    }
    const hydrated = await stream()
    expect(hydrated.events[0]?.type).toBe('snapshot')
    const resumed = await stream(resumeCursor)
    if (snapshotCatchUp) {
      expect(resumed.events.some((event) => event.type === 'snapshot')).toBe(true)
    } else if (kind === 'mixed') {
      expect(resumed.events.every((event) => event.type === 'batch')).toBe(true)
      // Old rows after the cursor, then records after the marker.
      const batches = resumed.events.flatMap((event) =>
        event.type === 'batch' ? [event.batch] : []
      )
      expect(batches.some((batch) => JSON.stringify(batch.items).includes(PROMPT))).toBe(true)
      expect(batches.some((batch) => batch.removedItemIds.includes(disposable.itemId))).toBe(true)
    } else {
      expect(resumed.events.every((event) => event.type === 'batch')).toBe(true)
      expect(
        resumed.events.filter(
          (event) =>
            event.type === 'batch' &&
            (event.batch.items.length > 0 || event.batch.removedItemIds.length > 0)
        )
      ).toHaveLength(2)
      expect(resumed.events.some((event) => event.type === 'batch' && event.hasNewer)).toBe(true)
      expect(
        resumed.events.some(
          (event) =>
            event.type === 'batch' && event.batch.removedItemIds.includes(disposable.itemId)
        )
      ).toBe(true)
    }
    const restored = active.host.collaboratorsForTests().sessions.get(SESSION)?.journal
    if (!restored) {
      throw new Error('History failed to reopen journal')
    }
    const priorHydrated = hydrated.events.length
    const priorResumed = resumed.events.length
    const published = await restored.appendItem(
      { provider: 'orca', clientMessageId: 'published' },
      message(PUBLISHED),
      options
    )
    await vi.waitFor(() => {
      for (const [reader, from] of [
        [hydrated, priorHydrated],
        [resumed, priorResumed]
      ] as const) {
        expect(
          reader.events
            .slice(from)
            .some(
              (event) =>
                event.type === 'batch' &&
                event.batch.items.some((item) => item.itemId === published.itemId)
            )
        ).toBe(true)
      }
    })
    for (const [reader, initial] of [
      [hydrated, EMPTY_STRUCTURED_AGENT_SESSION],
      [
        resumed,
        reduceStructuredAgentSession(
          EMPTY_STRUCTURED_AGENT_SESSION,
          { type: 'history-page', page: resumeFrom },
          1_000
        )
      ]
    ] as const) {
      let state = reader.events.reduce(
        (state, event) => reduceStructuredAgentSession(state, { type: 'event', event }, 1_000),
        initial
      )
      expect(state.status).toBe('ready')
      expect(state.hasOlder).toBe(true)
      expect(JSON.stringify(state.items)).not.toContain(OLDER)
      expect(JSON.stringify(state.items)).not.toContain(OLDER_ANSWER)
      const cursor = oldestStructuredAgentSessionCursor(state)
      if (!cursor) {
        throw new Error('Missing older-history cursor')
      }
      const before = await history({
        direction: 'before',
        cursor,
        limit: AGENT_SESSION_HISTORY_MAX_LIMIT
      })
      expect(JSON.stringify(before.items)).toContain(OLDER)
      expect(JSON.stringify(before.items)).toContain(OLDER_ANSWER)
      state = reduceStructuredAgentSession(
        state,
        { type: 'older-page', requestedCursor: cursor, page: before },
        1_000
      )
      if (bounded) {
        for (const frame of reader.rawFrames) {
          expect(Buffer.byteLength(frame)).toBeLessThanOrEqual(MOBILE_BRIDGE_MAX_FRAME_BYTES)
        }
        phone(state)
      } else {
        desktop(state)
      }
    }
  }
)
