// @vitest-environment happy-dom
import type * as StructuredSessionClient from '@/runtime/structured-agent-session-client'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { createElement, Fragment } from 'react'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../src/shared/agent-session-record.test-fixture'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../src/shared/agent-session-journal-types'
import { computeAgentSessionPayloadFingerprint } from '../../src/shared/agent-session-mutation-envelope'
import type { AiVaultListResult, AiVaultSession } from '../../src/shared/ai-vault-types'
import {
  projectStructuredAiVaultSessions,
  OPENS_EVERY_STRUCTURED_CHAT
} from '../../src/main/ai-vault/structured-session-ownership'
import {
  openTestAgentSessionRecordStore,
  seedTestAgentSessionRecordStore,
  readPersistedTestAgentSessionStore
} from '../../src/main/runtime/agent-session-record-store-test-harness'
import { AgentSessionJournal } from '../../src/main/native-chat/agent-session-journal/journal-store'
import {
  openTestJournalHostDatabase,
  closeTestJournalHostDatabases
} from '../../src/main/native-chat/agent-session-journal/journal-host-database-test-support'
import { StructuredAgentSessionHost } from '../../src/main/native-chat/agent-session-wire/structured-agent-session-host'
import { setStructuredAgentSessionHost } from '../../src/main/native-chat/agent-session-wire/structured-agent-session-registry'
import { structuredAgentsDeclaringNothing } from '../../src/main/native-chat/agent-session-wire/structured-agent-session-adapter-router-test-support'
import { recordingStructuredAgentSessionLogger } from '../../src/main/native-chat/agent-session-wire/structured-agent-session-logger-test-support'
import { createStructuredChatNamingHandler } from '../../src/main/native-chat/structured-chat-naming'
import { PI_RPC_AGENT } from '../../src/main/pi/rpc-agent-definition'
import type { AgentSessionStatusEvent } from '../../src/shared/agent-session-wire'
import { useAppStore } from '@/store'
import {
  getStructuredAgentSessionStatusFeed,
  resetStructuredAgentSessionStatusFeedsForTests
} from '@/runtime/structured-agent-session-status-feed'
import {
  resetAiVaultForcedRescanThrottleForTest,
  useAiVaultSessionRefresh
} from '../../src/renderer/src/components/right-sidebar/ai-vault-session-refresh'
import { aiVaultSessionRowResumeGating } from '../../src/renderer/src/components/right-sidebar/ai-vault-session-resume'
import { useAiVaultSessionDisplayTitle } from '../../src/renderer/src/components/right-sidebar/use-ai-vault-session-display-title'

const mocks = vi.hoisted(() => ({ subscribe: vi.fn() }))
vi.mock('@/store', async () => {
  const { createTestStore } = await import('@/store/slices/store-test-helpers')
  return { useAppStore: createTestStore() }
})
vi.mock('@/runtime/structured-agent-session-client', async (importOriginal) => ({
  ...(await importOriginal<typeof StructuredSessionClient>()),
  subscribeStructuredAgentSessionStatus: mocks.subscribe
}))

const SESSION = 'native-pi-history-clear'
const PROVIDER = '019fd622-3c4d-7e5f-a061-7c8d9e0f1a2b'
const FILE = `/sessions/2026-10-23T10-00-00-000Z_${PROVIDER}.jsonl`
const NAME = 'Budget plan'
const PATHS = ['/repo']
const initialState = useAppStore.getInitialState()
let directory: string | null = null
let host: StructuredAgentSessionHost | null = null

function HistoryRow({ session }: { session: AiVaultSession }) {
  const title = useAiVaultSessionDisplayTitle(session)
  return createElement(
    'div',
    {
      'data-testid': 'history-row',
      'data-owner': session.structuredSession?.sessionId,
      'data-copy-resume': aiVaultSessionRowResumeGating(session, { blocked: false })
        .canCopyResumeCommand,
      'data-resume': session.resumeCommand
    },
    title
  )
}
function History() {
  const { sessions } = useAiVaultSessionRefresh(PATHS, 'local', 250)
  return createElement(
    Fragment,
    null,
    sessions.map((session) => createElement(HistoryRow, { key: session.id, session }))
  )
}

async function disposeHistory() {
  cleanup()
  resetStructuredAgentSessionStatusFeedsForTests()
  setStructuredAgentSessionHost(null)
  await host?.flushAllStreamedEvents()
  host = null
  closeTestJournalHostDatabases()
  if (directory) {
    await rm(directory, { recursive: true, force: true })
  }
  directory = null
  useAppStore.setState(initialState, true)
}
afterEach(disposeHistory)

it('detaches a mounted provider History row after clear without losing the native manual name', async () => {
  for (const remount of [false, true]) {
    resetAiVaultForcedRescanThrottleForTest()
    resetStructuredAgentSessionStatusFeedsForTests()
    directory = await mkdtemp(join(tmpdir(), 'orca-history-manual-clear-'))
    const lease = agentSessionLeaseFixture({
      sessionId: SESSION,
      ownerProcess: null,
      reservedSpawnToken: null,
      claimStatus: 'released'
    })
    const record = {
      ...agentSessionRecordFixture(lease),
      provider: 'pi' as const,
      accountHome: { variable: 'PI_CODING_AGENT_DIR' as const, path: directory },
      providerHandleChain: [
        {
          linkId: 'pi-link',
          origin: 'created' as const,
          mintedAtFence: lease.runtimeFence,
          observedAt: 1000,
          handle: { transport: 'jsonl-rpc' as const, agent: 'pi' as const, nativeId: FILE }
        }
      ]
    }
    await seedTestAgentSessionRecordStore(directory, { records: [record] })
    const store = await openTestAgentSessionRecordStore(directory)
    const database = openTestJournalHostDatabase(directory)
    const journal = new AgentSessionJournal({
      database,
      identity: {
        sessionId: SESSION,
        workspaceId: 'workspace-1',
        hostId: 'local',
        agent: 'pi',
        providerHandle: null
      }
    })
    await journal.open()
    await journal.appendItem(
      { provider: 'legacy', agent: 'pi', sessionId: FILE, recordId: 'completed-reply' },
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Inventory checked' }] },
      { fence: lease.runtimeFence, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    await journal.close()
    const { logger } = recordingStructuredAgentSessionLogger()
    const unexpectedLaunch = (): never => {
      throw new Error('Clear must not launch a provider')
    }
    host = new StructuredAgentSessionHost({
      store,
      journalDatabase: database,
      logger,
      agents: structuredAgentsDeclaringNothing([PI_RPC_AGENT]),
      adapter: {
        acquire: unexpectedLaunch,
        open: unexpectedLaunch,
        dispatch: unexpectedLaunch,
        cancelTurn: async () => ({ cancelled: true }),
        answerPrompt: async () => {},
        setOption: async () => {},
        closeSession: async () => true
      },
      claimKeyId: 'key-1',
      mintSpawnToken: () => 'unused',
      probeOwner: async () => ({ outcome: 'pid-absent' }),
      conversationNaming: createStructuredChatNamingHandler({
        getStore: () => store,
        getSettings: () => ({}),
        workerTaskTitle: () => null,
        readFirstPrompt: async () => '',
        readJournalFirstPrompt: async () => '',
        generate: async () => null,
        onNamed: () => host?.publishConversationName(SESSION),
        logger
      })
    })
    setStructuredAgentSessionHost(host)
    await host.revealSession(SESSION)
    expect(await host.setUserConversationName(SESSION, NAME, 'rename')).toEqual({
      name: NAME,
      applied: true
    })
    let emitFrame = (_event: AgentSessionStatusEvent): void => {}
    const unsubscribe = vi.fn()
    mocks.subscribe.mockImplementation(async (_target, emit) => {
      emitFrame = emit
      const stop = host?.subscribeStatus({ id: 'history-clear-test', emit })
      return {
        unsubscribe: () => {
          unsubscribe()
          stop?.()
        }
      }
    })
    const scanned: AiVaultListResult = {
      scannedAt: 'unchanged-provider-scan',
      issues: [],
      sessions: [
        {
          id: `local:pi:${PROVIDER}`,
          executionHostId: 'local',
          agent: 'pi',
          sessionId: PROVIDER,
          filePath: FILE,
          title: 'Check inventory',
          cwd: '/repo',
          branch: null,
          model: null,
          codexHome: null,
          createdAt: null,
          updatedAt: null,
          modifiedAt: '2026-10-23T10:00:00Z',
          messageCount: 2,
          totalTokens: 0,
          previewMessages: [],
          queuedMessageCount: 0,
          subagentTranscriptCount: 0,
          resumeCommand: `pi --session ${FILE}`,
          subagent: null
        }
      ]
    }
    const project = () => projectStructuredAiVaultSessions(scanned, OPENS_EVERY_STRUCTURED_CHAT)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        aiVault: {
          listSessions: vi.fn(async () => project()),
          cancelListSessions: vi.fn(async () => {}),
          onWindowFocused: () => () => {}
        }
      }
    })
    // History owns its feed even when no chat tab or pane projector exists.
    let view = render(createElement(History))
    await waitFor(() => expect(screen.getByTestId('history-row').textContent).toBe(NAME))
    expect(screen.getByTestId('history-row').getAttribute('data-owner')).toBe(SESSION)
    expect(screen.getByTestId('history-row').getAttribute('data-copy-resume')).toBe('false')

    const feed = getStructuredAgentSessionStatusFeed({ kind: 'local' })
    const confirmed = feed.getSnapshot().get(SESSION)!
    const revision = feed.getAssociationRevision()
    const queries = window.api.aiVault.listSessions
    const beforeChurn = vi.mocked(queries).mock.calls.length
    for (const n of [10, 100]) {
      await act(async () => {
        for (let i = 0; i < n; i++) {
          emitFrame({
            type: 'status',
            session: { ...confirmed, updatedAt: i, latestPrompt: `${i}` }
          })
          emitFrame({
            type: 'snapshot',
            sessions: [],
            namingActiveSessionIds: [],
            conversationNames: [{ sessionId: SESSION, conversationName: NAME }]
          })
        }
      })
      expect(vi.mocked(queries).mock.calls).toHaveLength(beforeChurn)
      expect(feed.getAssociationRevision()).toBe(revision)
    }
    const oldProjection = project()
    if (remount) {
      view.unmount()
      expect(unsubscribe).toHaveBeenCalledOnce()
    }
    let settleOld = (_result: AiVaultListResult): void => {}
    if (remount) {
      vi.mocked(queries).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            settleOld = resolve
          })
      )
    }
    await act(async () => {
      const command = 'clear'
      const clearing = host?.conversationCommand(
        { callerKey: 'desktop' },
        {
          command,
          envelope: {
            sessionId: SESSION,
            clientOperationId: `${Date.now()}-${'1'.repeat(32)}`,
            expectedRuntimeFence: store.getRecord(SESSION)?.lease.runtimeFence ?? null,
            payloadFingerprint: computeAgentSessionPayloadFingerprint({
              method: 'agentSession.conversationCommand',
              sessionId: SESSION,
              fields: { command }
            })
          }
        }
      )
      if (remount) {
        view = render(createElement(History))
      }
      expect(await clearing).toMatchObject({
        ok: true,
        value: { command: 'clear', state: 'completed' }
      })
    })
    const beforeSettlement = vi.mocked(queries).mock.calls.length
    if (remount) {
      expect(screen.getByTestId('history-row').textContent).toBe(NAME)
      await act(async () => settleOld(oldProjection))
    }
    const saved = (await readPersistedTestAgentSessionStore(directory)).records[SESSION]
    expect(saved).toMatchObject({
      conversationName: NAME,
      conversationNameSource: 'user',
      providerHandleChain: []
    })
    expect(project().sessions[0]).toMatchObject({ title: 'Check inventory' })
    expect(project().sessions[0]?.structuredSession).toBeUndefined()
    const published = getStructuredAgentSessionStatusFeed({ kind: 'local' })
      .getSnapshot()
      .get(SESSION)
    expect(published).toMatchObject({ sessionId: SESSION, conversationName: NAME })
    expect(published?.providerSession).toBeUndefined()
    await waitFor(() => {
      expect(screen.getByTestId('history-row').textContent).toBe('Check inventory')
      expect(screen.getByTestId('history-row').getAttribute('data-owner')).toBeNull()
      expect(screen.getByTestId('history-row').getAttribute('data-copy-resume')).toBe('true')
      expect(screen.getByTestId('history-row').getAttribute('data-resume')).toBe(
        `pi --session ${FILE}`
      )
    })
    expect(vi.mocked(queries).mock.calls).toHaveLength(beforeSettlement + (remount ? 1 : 0))
    expect(vi.mocked(queries).mock.calls.every(([args]) => args?.force !== true)).toBe(true)
    view.unmount()
    expect(unsubscribe).toHaveBeenCalledTimes(remount ? 2 : 1)
    expect((await readPersistedTestAgentSessionStore(directory)).records[SESSION]).toMatchObject({
      conversationName: NAME,
      conversationNameSource: 'user'
    })
    await disposeHistory()
  }
})
