import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentSessionHistoryRequest,
  AgentSessionHistoryResult,
  AgentSessionStatusSummary,
  AgentSessionSubscribeEvent
} from '../../src/shared/agent-session-wire'
import type { AgentJournalCursor } from '../../src/shared/agent-session-journal-types'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession
} from '../../src/shared/structured-agent-session-reducer'
import {
  hasUnansweredStructuredAgentSessionDispatch,
  projectStructuredAgentSessionStatus
} from '../../src/shared/structured-agent-session-projection'
import { createTrackedJournalOpener } from '../../src/main/native-chat/agent-session-journal/journal-store-test-open'
import { readAgentSessionHistory } from '../../src/main/native-chat/agent-session-wire/agent-session-history-page'
import { AgentSessionSubscribers } from '../../src/main/native-chat/agent-session-wire/structured-agent-session-subscribers'
import { StructuredAgentSessionStatusFeed } from '../../src/main/native-chat/agent-session-wire/structured-agent-session-status-feed'

const mocks = vi.hoisted(() => ({ call: vi.fn(), subscribe: vi.fn() }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call,
  subscribeStructuredAgentSession: mocks.subscribe
}))

import {
  getStructuredAgentSessionReadOwner,
  resetStructuredAgentSessionReadOwnersForTests
} from '../../src/renderer/src/components/native-chat/structured-agent-session-read-owner'

const SESSION = 'cursor-body-regression'
const target = { kind: 'local' } as const
const journals = createTrackedJournalOpener()
let root: string

beforeEach(async () => {
  vi.resetAllMocks()
  root = await mkdtemp(join(tmpdir(), 'orca-cursor-body-'))
})
afterEach(async () => {
  resetStructuredAgentSessionReadOwnersForTests()
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const journal = await journals.open({
    identity: {
      sessionId: SESSION,
      workspaceId: 'folder-workspace',
      hostId: 'local',
      agent: 'codex',
      providerHandle: { kind: 'codex', threadId: 'thread-1' }
    },
    journalDir: join(root, 'journal')
  })
  async function appendOutput(index: number) {
    await journal.appendItem(
      { provider: 'orca', clientMessageId: `output-${index}` },
      { kind: 'status', text: `Tool output ${index}` },
      { fence: 1 }
    )
  }
  for (let index = 1; index < 99; index += 1) {
    await appendOutput(index)
  }
  await journal.appendSubmission({
    clientMessageId: 'pending-send',
    payloadFingerprint: 'prompt',
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Run tools' }] },
    fence: 1
  })
  expect(journal.cursor().sequence).toBe(100)
  const initial = structuredClone(
    readAgentSessionHistory(journal, { sessionId: SESSION, direction: 'tail' })
  )
  const accept = () =>
    journal.resolveDispatch({
      clientMessageId: 'pending-send',
      fence: 1,
      state: 'accepted',
      providerIdentity: { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal: 0 }
    })
  return { journal, initial, appendOutput, accept }
}

describe('structured session cursor/body regression', () => {
  it('replaces retained pending submissions together with a real bounded snapshot at 140', async () => {
    const { journal, initial, appendOutput, accept } = await fixture()
    const retained = reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, {
      type: 'event',
      event: { type: 'snapshot', sessionId: SESSION, page: initial.page, fence: 1 }
    })
    expect(retained.submissions[0]?.dispatchState).toBe('pending')
    await accept()
    for (let index = 102; index <= 140; index += 1) {
      await appendOutput(index)
    }
    const bounded = readAgentSessionHistory(journal, {
      sessionId: SESSION,
      direction: 'tail',
      limit: 1
    }).page
    expect(bounded.liveCursor?.sequence).toBe(140)
    expect(bounded.items).not.toContainEqual(retained.items.at(-1))
    expect(bounded.submissions).toEqual([])

    const replaced = reduceStructuredAgentSession(retained, {
      type: 'event',
      event: { type: 'snapshot', sessionId: SESSION, page: bounded, fence: 1 }
    })
    expect(replaced.cursor).toEqual(bounded.liveCursor)
    expect(replaced.submissions).toEqual(bounded.submissions)
    expect(hasUnansweredStructuredAgentSessionDispatch(replaced.submissions, 1)).toBe(false)
  })

  it.each([40, 401])(
    'replays an off-page dispatch after %i missed rows without stranding pending state',
    async (missedRows) => {
      const { journal, appendOutput, accept } = await fixture()
      let hostSummary: AgentSessionStatusSummary | undefined
      const feed = new StructuredAgentSessionStatusFeed({
        sessions: new Map([
          [
            SESSION,
            {
              journal,
              fence: 1,
              params: { location: { workspaceId: 'folder-workspace' }, provider: 'codex' }
            }
          ]
        ]),
        getRecord: () => null,
        now: () => 1_000,
        onStatusChanged: (summary) => {
          hostSummary = summary
        }
      })
      const subscribers = new AgentSessionSubscribers({
        onJournalPublished: (sessionId, published) => feed.publish(sessionId, published)
      })
      const delayedOlder = Promise.withResolvers<AgentSessionHistoryResult>()
      let warm = false
      mocks.call.mockImplementation((_target, _method, request: AgentSessionHistoryRequest) => {
        // Hold the measured bounded page before its asynchronous older-page fill can mask it.
        if (warm && missedRows === 40 && request.direction === 'before') {
          return delayedOlder.promise
        }
        const result = readAgentSessionHistory(journal, {
          ...request,
          ...(warm && missedRows === 40 ? { limit: 1 } : {})
        })
        return Promise.resolve(
          structuredClone({
            ...result,
            page: { ...result.page, fence: 1, hostNow: 1234 },
            providerSession: { key: 'session_id', id: 'provider-1' }
          })
        )
      })
      mocks.subscribe.mockImplementation(
        (
          _target,
          request: { cursor?: AgentJournalCursor },
          onEvent: (event: AgentSessionSubscribeEvent) => void
        ) =>
          Promise.resolve({
            unsubscribe: subscribers.open({
              id: 'pane',
              sessionId: SESSION,
              journal,
              fence: 1,
              cursor: request.cursor,
              emit: (event) => onEvent(structuredClone(event))
            })
          })
      )
      const owner = getStructuredAgentSessionReadOwner(SESSION, target)
      const unlisten = owner.subscribe(() => {})
      const deactivate = owner.activate()
      await vi.waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(1))
      expect(owner.getSnapshot().state.cursor?.sequence).toBe(100)
      expect(owner.getSnapshot().state.items.at(-1)?.body).toMatchObject({ role: 'user' })
      expect(owner.getSnapshot().state.submissions[0]?.dispatchState).toBe('pending')
      expect(owner.getSnapshot().providerSession).toEqual({ key: 'session_id', id: 'provider-1' })
      expect(owner.getSnapshot().state.hostClock?.hostNow).toBe(1234)
      expect(mocks.call).toHaveBeenCalledTimes(1)
      deactivate()

      await accept()
      for (let index = 102; index <= 100 + missedRows; index += 1) {
        await appendOutput(index)
      }
      const tail = readAgentSessionHistory(journal, {
        sessionId: SESSION,
        direction: 'tail',
        limit: missedRows === 40 ? 1 : 200
      }).page
      expect(tail.liveCursor?.sequence).toBe(100 + missedRows)
      expect(tail.submissions).toEqual([])
      feed.publish(SESSION, journal)
      // IPC/RPC copies values; the journal mutates its own submission records in place.
      expect(owner.getSnapshot().state.submissions[0]?.dispatchState).toBe('pending')
      warm = true
      const stop = owner.activate()

      await vi.waitFor(() => expect(owner.getSnapshot().state.cursor).toEqual(journal.cursor()))
      const caughtUp = owner.getSnapshot().state
      if (missedRows === 40) {
        expect({
          cursor: caughtUp.cursor?.sequence,
          dispatch: caughtUp.submissions[0]?.dispatchState,
          unansweredDispatch: hasUnansweredStructuredAgentSessionDispatch(caughtUp.submissions, 1)
        }).toEqual({ cursor: 140, dispatch: 'accepted', unansweredDispatch: false })
      }

      await journal.appendItem(
        { provider: 'orca', clientMessageId: 'completed-turn' },
        { kind: 'turn', turnId: 'turn-1', state: 'completed' },
        { fence: 1 }
      )
      subscribers.publish(SESSION, journal)
      await vi.waitFor(() => expect(owner.getSnapshot().state.cursor).toEqual(journal.cursor()))
      const settled = owner.getSnapshot().state
      expect(hostSummary?.status).toBe('idle')
      expect(
        projectStructuredAgentSessionStatus(settled.items, settled.submissions, settled.fence)
      ).toBe(hostSummary?.status)
      expect(settled.submissions).toEqual(journal.snapshot().submissions)
      expect({
        cursor: caughtUp.cursor?.sequence,
        dispatch: caughtUp.submissions[0]?.dispatchState,
        unansweredDispatch: hasUnansweredStructuredAgentSessionDispatch(caughtUp.submissions, 1)
      }).toEqual({ cursor: 100 + missedRows, dispatch: 'accepted', unansweredDispatch: false })
      expect(mocks.call).toHaveBeenCalledTimes(1)
      expect(mocks.subscribe).toHaveBeenCalledTimes(2)
      expect(mocks.subscribe.mock.calls[1]?.[1]).toEqual({
        sessionId: SESSION,
        cursor: { epoch: journal.cursor().epoch, sequence: 100 }
      })

      stop()
      unlisten()
    }
  )
})
