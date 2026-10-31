import { vi } from 'vitest'
import type { Mock } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  agentSessionRecordFixture,
  agentSessionLeaseFixture
} from '../../../src/shared/agent-session-record.test-fixture'
import type { AgentSessionRecord } from '../../../src/shared/agent-session-record'
import { agentSessionRefusalError } from '../../../src/shared/agent-session-wire-refusals'
import type { AiVaultChatForkSource } from '../../../src/shared/ai-vault-resume-preparation'
import type { StructuredAgentSessionAdapter } from '../../../src/main/native-chat/agent-session-wire/structured-agent-session-adapter'
import { startsWhenPublished } from '../../../src/main/native-chat/agent-session-wire/structured-agent-session-instant-start.test-support'
import type { AgentSessionRecordStore } from '../../../src/main/runtime/agent-session-record-store'
import { codexProviderHandle } from '../../../src/shared/agent-session-provider-handle-encoding'
import type { StructuredAgentSessionHost } from '../../../src/main/native-chat/agent-session-wire/structured-agent-session-host'
import { setStructuredAgentSessionHost } from '../../../src/main/native-chat/agent-session-wire/structured-agent-session-registry'
import { CODEX_STRUCTURED_AGENT } from '../../../src/main/codex/codex-structured-agent-definition'
import {
  AGENT_SESSION_TURN_ITEM_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
} from '../../../src/shared/protocol-version'

type StructuredHostCalls = Record<string, ReturnType<typeof vi.fn>> & {
  getRecord: Mock<(sessionId: string) => AgentSessionRecord | null>
}

// Use per-method spies so every skew can prove which call reached the host.
export function structuredHostStub(sessionId: string, workspaceId: string): StructuredHostCalls {
  return {
    getRecord: vi.fn<(sessionId: string) => AgentSessionRecord | null>(() => null),
    switchToTerminal: vi.fn<StructuredAgentSessionHost['switchToTerminal']>(async () => undefined),
    switchToChat: vi.fn<StructuredAgentSessionHost['switchToChat']>(async () => ({ ok: true })),
    // The restart-resume surface hangs off a host MEMBER rather than the root, but its spies stay
    // flat here: callers iterate this map asserting every entry is a spy that did not run, and
    // `installableHost` below is what reassembles the member. Keeping them flat also lets the
    // manifest name them to prove a call reached the host.
    restartResumableList: vi.fn(async () => []),
    restartResumableFailures: vi.fn(async () => []),
    restartResumableDismiss: vi.fn(async () => 0),
    restartResumeAll: vi.fn(async () => []),
    restartContinueAll: vi.fn(async () => ({ resumed: [], continued: [] })),
    continueInterrupted: vi.fn(async () => ({ sessionId, outcome: 'superseded' })),
    attach: vi.fn(async () => ({ ok: true, replayed: false, value: { sessionId } })),
    create: vi.fn(async () => ({ ok: true, replayed: false, value: { sessionId } })),
    // Accept create-location probes so an unstubbed harness method cannot cause every ensure to refuse.
    supportsCreate: vi.fn(() => true),
    conversationCommand: vi.fn(async () => ({
      ok: true,
      value: { command: 'compact', state: 'completed' }
    })),
    send: vi.fn(async () => ({
      ok: true,
      replayed: false,
      fence: 1,
      cursor: { epoch: 'epoch-a', sequence: 2 },
      value: {
        clientMessageId: 'client-1',
        submission: {
          clientMessageId: 'client-1',
          fence: 1,
          payloadFingerprint: 'fingerprint',
          dispatchState: 'accepted',
          providerItemId: 'provider-1',
          reason: null,
          submittedAt: 1,
          resolvedAt: 2
        }
      }
    })),
    waitForSendSettlement: vi.fn(),
    cancel: vi.fn(async () => ({ ok: true, replayed: false })),
    queuedMessageSend: vi.fn(async () => ({ ok: true, replayed: false })),
    queuedMessageDelete: vi.fn(async () => ({ ok: true, replayed: false })),
    queuedMessageMove: vi.fn(async () => ({
      ok: true,
      value: { messageId: 'queued-1', status: 'moved' }
    })),
    queuedMessagesResume: vi.fn(async () => ({ ok: true, replayed: false })),
    queuedMessageUpdate: vi.fn(async () => ({ ok: true, replayed: false })),
    queuedMessageEditHold: vi.fn(async () => ({
      status: 'held' as const,
      fingerprint: 'a'.repeat(64),
      leaseDurationMs: 120_000,
      remainingMs: 120_000
    })),
    rewind: vi.fn(async () => ({
      ok: true,
      replayed: false,
      value: { itemId: 'item-1', epoch: 'rewound-epoch' }
    })),
    close: vi.fn(async () => undefined),
    sleepWorkspace: vi.fn(async () => ({ stoppedSessionIds: [] })),
    revealSession: vi.fn(async () => ({
      sessionId,
      workspaceId,
      agent: 'codex' as const,
      readable: true
    })),
    regenerateConversationName: vi.fn(() => true),
    setUserConversationName: vi.fn(async () => ({ name: 'Release notes', applied: true })),
    hold: vi.fn(async () => undefined),
    release: vi.fn(() => undefined),
    respondToPrompt: vi.fn(async () => ({ ok: true, replayed: false })),
    setOption: vi.fn(async () => ({ ok: true, replayed: false })),
    changeThreadGoal: vi.fn(async () => ({ ok: true, replayed: false })),
    handoffStatus: vi.fn(async () => ({ owner: 'native' })),
    readOptions: vi.fn(async () => ({ models: [], current: { model: 'gpt-live' } })),
    continuationContext: vi.fn(async () => ({
      status: 'current',
      capturedText: 'Saved context',
      transcriptPath: '/handoff/chat.txt'
    })),
    modelCatalog: vi.fn(() => ({ origin: 'unknown' as const })),
    readCommands: vi.fn(() => ({ commands: [{ name: 'clear', kind: 'command' as const }] })),
    history: vi.fn(() => ({ ok: true, page: { items: [] } })),
    readCurrentRequests: vi.fn(() => ({ json: '[]', nextCursor: null })),
    sessionAgent: vi.fn(() => null),
    journalSnapshot: vi.fn(() => ({
      sessionId,
      cursor: { epoch: 'epoch-a', sequence: 0 },
      items: [],
      submissions: []
    })),
    subscribe: vi.fn(() => () => undefined),
    subscribeStatus: vi.fn((subscriber: { emit: (event: unknown) => void }) => {
      subscriber.emit({ type: 'snapshot', sessions: [] })
      return () => undefined
    }),
    // Completions are edges: late subscribers get no opening snapshot.
    subscribeTurnCompletions: vi.fn(() => () => undefined),
    unsubscribe: vi.fn(),
    agentDefinitions: vi.fn(() => [CODEX_STRUCTURED_AGENT]),
    knownAgentIds: vi.fn(() => [CODEX_STRUCTURED_AGENT.agent])
  }
}

// Install the nested host shape, but assert against the flat spy map.
export function installableHost(hostCalls: StructuredHostCalls): StructuredAgentSessionHost {
  const host = {
    ...hostCalls,
    readModelCatalog: hostCalls.modelCatalog,
    // The catalog read checks the session's record for a floating chat's own folder; none here.
    deps: {
      modelCatalog: { read: hostCalls.modelCatalog, demand: vi.fn(async () => {}) },
      store: {
        getRecord: hostCalls.getRecord,
        selectWritableRecord: (sessionId: string) => {
          const record: AgentSessionRecord | null = hostCalls.getRecord(sessionId)
          return record ? { kind: 'writable' as const, record } : { kind: 'missing' as const }
        },
        requireWritableRecord: (sessionId: string) => {
          const record: AgentSessionRecord | null = hostCalls.getRecord(sessionId)
          if (!record) {
            throw agentSessionRefusalError('agent_session_identity_required', {
              reason: 'recordMissing'
            })
          }
          return record
        },
        getConversation: () => null,
        getOperationRow: () => null
      }
    },
    restartResume: {
      list: hostCalls.restartResumableList,
      listFailures: hostCalls.restartResumableFailures,
      dismiss: hostCalls.restartResumableDismiss,
      resume: hostCalls.restartResumeAll,
      continueAfterRestart: hostCalls.restartContinueAll,
      continueInterrupted: hostCalls.continueInterrupted
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a spy map standing in for the host; the dispatcher reaches only the members stubbed above, and a missing one fails the call rather than type-checking.
  return host as unknown as StructuredAgentSessionHost
}

/** A saved conversation for the real switch handler's account and transcript checks. */
export async function structuredSwitchSource(
  sessionId: string,
  workspaceId: string,
  thread: string
) {
  const root = await mkdtemp(join(tmpdir(), 'orca-cross-version-switch-'))
  const codexHome = join(root, 'codex-home')
  const sessions = join(codexHome, 'sessions')
  const filePath = join(sessions, `rollout-${thread}.jsonl`)
  await mkdir(sessions, { recursive: true })
  await writeFile(
    filePath,
    `${JSON.stringify({ type: 'session_meta', payload: { id: thread, cwd: root } })}\n`
  )
  const record: AgentSessionRecord = {
    ...agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId })),
    provider: 'codex',
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId,
      workspaceKind: 'git-worktree'
    },
    accountHome: { variable: 'CODEX_HOME', path: codexHome },
    launchDirectory: root,
    providerHandleChain: [
      {
        linkId: 'link-1',
        origin: 'created',
        mintedAtFence: 7,
        observedAt: 1_000,
        handle: codexProviderHandle(thread)
      }
    ]
  }
  const source: AiVaultChatForkSource = {
    agent: 'codex',
    sourceAgent: 'codex',
    sessionId: thread,
    cwd: root,
    codexHome,
    filePath,
    executionHostPlatform: process.platform
  }
  return { record, source, dispose: () => rm(root, { recursive: true, force: true }) }
}

const TURN = { turnId: 'turn-1', state: 'completed' as const, startedAt: 1, completedAt: 6 }
const TURN_ROW = { itemId: 'legacy:codex:s:turn-1', revision: 1, sequence: 1, observedAt: 1 }

// Remove the new capability from baseline clients so turn-item downgrade remains exercised after release.
export const turnItemSkew = {
  install(sessionId: string, workspaceId: string): void {
    const host = structuredHostStub(sessionId, workspaceId)
    const items = [{ ...TURN_ROW, body: { kind: 'turn', ...TURN } }]
    host.history.mockReturnValue({ ok: true, page: { items } })
    setStructuredAgentSessionHost(installableHost(host))
  },
  clients(
    baseline: { capabilities: readonly string[] },
    current: { capabilities: readonly string[] }
  ) {
    const old = baseline.capabilities.filter((c) => c !== AGENT_SESSION_TURN_ITEM_CAPABILITY)
    return [
      [
        [...old, STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY],
        { ...TURN_ROW, body: { kind: 'status', turnLifecycle: TURN } }
      ],
      [[...current.capabilities], { ...TURN_ROW, body: { kind: 'turn', ...TURN } }]
    ] as const
  }
}

// Model an instant Codex handshake for real-host tests that need a ready provider.
export function readyCodexProviderAdapter(input: {
  store: Pick<AgentSessionRecordStore, 'getRecord'>
  sessionId: string
  thread: string
  now: number
  spawnToken: string
  host: () => StructuredAgentSessionHost
}): StructuredAgentSessionAdapter {
  const { store, now } = input
  let dispatched = 0
  return startsWhenPublished(
    {
      acquire: async ({ fence }) => ({
        acquisitionGeneration: `wire-host-${fence}`,
        process: {
          hostId: 'local',
          pid: 4242,
          processStartTimeMs: now,
          spawnToken: store.getRecord(input.sessionId)?.lease.reservedSpawnToken ?? input.spawnToken
        },
        link: {
          linkId: `link-${fence}`,
          handle: codexProviderHandle(input.thread),
          origin: 'created',
          mintedAtFence: fence,
          observedAt: now
        }
      }),
      dispatch: async () => {
        dispatched += 1
        return {
          state: 'accepted',
          providerIdentity: {
            provider: 'codex',
            threadId: input.thread,
            turnId: `turn-${dispatched}`,
            ordinal: dispatched
          }
        }
      },
      cancelTurn: async () => ({ cancelled: true }),
      answerPrompt: async () => undefined,
      setOption: async () => undefined
    },
    input.host
  )
}
