// Cross-version coverage for the structured agent-session surface, paired the same
// way the terminal wire harness is: current code against a real published release.
//
// Three skews matter here, and none can be checked from one build alone — an old
// client must not be shown a session it cannot render, a new client must find an
// old host's missing surface cleanly, and a client's cursor must survive the host
// process that minted it.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StructuredAgentSessionAdapter } from '../../../src/main/native-chat/agent-session-wire/structured-agent-session-adapter'
import { attachFingerprintFields } from '../../../src/main/native-chat/agent-session-wire/structured-agent-session-attach'
import type { AgentSessionAttachParams } from '../../../src/main/native-chat/agent-session-wire/structured-agent-session-attach'
import { StructuredAgentSessionHost } from '../../../src/main/native-chat/agent-session-wire/structured-agent-session-host'
import { setStructuredAgentSessionHost } from '../../../src/main/native-chat/agent-session-wire/structured-agent-session-registry'
import { AgentSessionRecordStore } from '../../../src/main/runtime/agent-session-record-store'
import { computeAgentSessionPayloadFingerprint } from '../../../src/shared/agent-session-mutation-envelope'
import type { AgentSessionSubscribeEvent } from '../../../src/shared/agent-session-wire'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../src/shared/protocol-version'
import { resolveBaselineReleaseRef } from './release-checkout'
import {
  loadAgentSessionWireBuild,
  WORKING_TREE,
  type AgentSessionWireBuild,
  type RpcClientIdentity,
  type RpcReply
} from './versioned-agent-session-wire'

// Why: a cold CI run extracts the baseline checkout before the first pairing.
const SUITE_TIMEOUT_MS = 180_000

const SESSION = 'session-alpha'
const WORKSPACE = 'workspace-1'
const THREAD = '019fd532-7c11-7a90-b6de-4e1a2c3d5f60'
const NOW = 1_800_000_000_000

/** Every method the structured surface publishes, paired with the host method it
 *  must reach — a gate that hides one method and leaks another is the bug. */
const STRUCTURED_CALLS: { method: string; hostMethod: string | null }[] = [
  { method: 'agentSession.createSupport', hostMethod: null },
  { method: 'agentSession.create', hostMethod: 'attach' },
  { method: 'agentSession.ensure', hostMethod: 'attach' },
  { method: 'agentSession.send', hostMethod: 'send' },
  { method: 'agentSession.cancel', hostMethod: 'cancel' },
  { method: 'agentSession.close', hostMethod: 'close' },
  { method: 'agentSession.respondToApproval', hostMethod: 'respondToPrompt' },
  { method: 'agentSession.respondToQuestion', hostMethod: 'respondToPrompt' },
  { method: 'agentSession.setOption', hostMethod: 'setOption' },
  { method: 'agentSession.handoffStatus', hostMethod: 'handoffStatus' },
  { method: 'agentSession.options', hostMethod: 'readOptions' },
  { method: 'agentSession.hold', hostMethod: 'hold' },
  { method: 'agentSession.release', hostMethod: 'release' },
  { method: 'agentSession.history', hostMethod: 'history' },
  { method: 'agentSession.subscribe', hostMethod: 'subscribe' },
  // Teardown runs through the runtime's subscription registry rather than the
  // host, so its reply is the only signal that the gate opened.
  { method: 'agentSession.unsubscribe', hostMethod: null }
]

let baselineRef: string
let current: AgentSessionWireBuild
let baseline: AgentSessionWireBuild
let operations = 0

beforeAll(async () => {
  baselineRef = resolveBaselineReleaseRef()
  current = await loadAgentSessionWireBuild(WORKING_TREE)
  baseline = await loadAgentSessionWireBuild(baselineRef)
}, SUITE_TIMEOUT_MS)

/** `<13-digit ms>-<32 hex>`, the only shape the durable ledger accepts. */
function operationId(): string {
  operations += 1
  return `${NOW}-${operations.toString(16).padStart(32, '0')}`
}

function envelope(args: {
  method: string
  fields: Record<string, unknown>
  fence: number | null
}): Record<string, unknown> {
  return {
    sessionId: SESSION,
    clientOperationId: operationId(),
    expectedRuntimeFence: args.fence,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method: args.method,
      sessionId: SESSION,
      fields: args.fields
    })
  }
}

function attachParams(fence: number | null): Record<string, unknown> {
  const params = {
    envelope: { sessionId: SESSION, clientOperationId: operationId(), expectedRuntimeFence: fence },
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: WORKSPACE,
      workspaceKind: 'git-worktree'
    },
    provider: 'codex',
    agent: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: '/home/dev/.codex' },
    runtimeKind: 'native',
    providerHandle: { kind: 'codex', threadId: THREAD }
  }
  return {
    ...params,
    envelope: {
      ...params.envelope,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.attach',
        sessionId: SESSION,
        fields: attachFingerprintFields(params as unknown as AgentSessionAttachParams)
      })
    }
  }
}

function createIntentParams(): Record<string, unknown> {
  const worktree = `id:${WORKSPACE}`
  const fields = { worktree, agent: 'codex' }
  return { envelope: envelope({ method: 'agentSession.create', fields, fence: null }), ...fields }
}

function sendParams(text: string, fence: number): Record<string, unknown> {
  const body = { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
  return { envelope: envelope({ method: 'agentSession.send', fields: { body }, fence }), body }
}

/** Schema-valid params per method; values only need to survive validation. */
function paramsFor(method: string): unknown {
  const fence = 1
  switch (method) {
    case 'agentSession.createSupport':
      return { worktree: `id:${WORKSPACE}`, agent: 'codex' }
    case 'agentSession.create':
      return createIntentParams()
    case 'agentSession.ensure':
      return attachParams(fence)
    case 'agentSession.send':
      return sendParams('hi', fence)
    case 'agentSession.cancel':
      return {
        envelope: envelope({ method: 'agentSession.cancel', fields: { turnId: 'turn-1' }, fence }),
        turnId: 'turn-1'
      }
    case 'agentSession.respondToApproval':
    case 'agentSession.respondToQuestion': {
      const fields = { itemId: 'item-1', expectedRevision: 1, optionId: 'allow' }
      return { envelope: envelope({ method, fields, fence }), ...fields }
    }
    case 'agentSession.setOption': {
      const fields = { key: 'model', value: 'gpt-5' }
      return { envelope: envelope({ method, fields, fence }), ...fields }
    }
    case 'agentSession.history':
      return { sessionId: SESSION, direction: 'tail' }
    case 'agentSession.hold':
    case 'agentSession.release':
      return { sessionId: SESSION, holderId: 'surface-1' }
    default:
      return { sessionId: SESSION }
  }
}

function runtimeStub(): unknown {
  const cleanups = new Map<string, () => void>()
  return {
    getRuntimeId: () => 'runtime-1',
    ensureStructuredAgentSessionHost: async () => undefined,
    getStructuredAgentSessionCreateSupport: async () => ({ supported: true }),
    resolveStructuredAgentSessionCreateIntent: async () => {
      const {
        envelope: _envelope,
        providerHandle: _providerHandle,
        ...resolved
      } = attachParams(null)
      return resolved
    },
    publishStructuredAgentSessionTab: () => {},
    registerSubscriptionCleanup: (id: string, cleanup: () => void) => cleanups.set(id, cleanup),
    cleanupSubscription: (id: string) => {
      cleanups.get(id)?.()
      cleanups.delete(id)
    },
    cleanupSubscriptionsByPrefix: (prefix: string) => {
      for (const [id, cleanup] of cleanups) {
        if (id.startsWith(prefix)) {
          cleanup()
          cleanups.delete(id)
        }
      }
    }
  }
}

/** Every reply one call produced. Streaming methods answer more than once, and a
 *  refusal has to arrive as a reply rather than as silence. */
async function callBuild(
  build: AgentSessionWireBuild,
  method: string,
  params: unknown,
  client: RpcClientIdentity,
  runtime: unknown = runtimeStub()
): Promise<RpcReply[]> {
  const replies: RpcReply[] = []
  await build
    .createDispatcher(runtime)
    .dispatchStreaming(
      { id: `request-${method}`, authToken: 'cross-version-token', method, params },
      (raw) => replies.push(JSON.parse(raw) as RpcReply),
      client
    )
  return replies
}

describe('cross-version structured agent sessions', () => {
  it(
    'skews current code against a real published release',
    () => {
      expect(baselineRef).toMatch(/^v?\d/)
      expect(baseline.revision).toMatch(/^[0-9a-f]{40}$/)
      expect(baseline.revision).not.toBe(current.revision)
      // The anti-vacuous oracle for the source scan: a scan that found nothing
      // would make every "no structured method here" claim below meaningless.
      expect(baseline.methodNames).toContain('terminal.create')
      expect(current.methodNames).toContain('terminal.create')
    },
    SUITE_TIMEOUT_MS
  )

  describe('a client that never asked for structured sessions', () => {
    let hostCalls: Record<string, ReturnType<typeof vi.fn>>

    beforeEach(() => {
      operations = 0
      hostCalls = {
        attach: vi.fn(async () => ({ ok: true, replayed: false, value: { sessionId: SESSION } })),
        send: vi.fn(async () => ({ ok: true, replayed: false })),
        cancel: vi.fn(async () => ({ ok: true, replayed: false })),
        close: vi.fn(async () => undefined),
        hold: vi.fn(async () => undefined),
        release: vi.fn(() => undefined),
        respondToPrompt: vi.fn(async () => ({ ok: true, replayed: false })),
        setOption: vi.fn(async () => ({ ok: true, replayed: false })),
        requestHandoff: vi.fn(async () => ({ status: { owner: 'native' } })),
        handoffStatus: vi.fn(async () => ({ owner: 'native' })),
        readOptions: vi.fn(async () => ({ models: [], current: { model: 'gpt-live' } })),
        history: vi.fn(() => ({ ok: true, page: { items: [] } })),
        subscribe: vi.fn(() => () => undefined),
        unsubscribe: vi.fn()
      }
      setStructuredAgentSessionHost(hostCalls as unknown as StructuredAgentSessionHost)
    })

    afterEach(() => {
      setStructuredAgentSessionHost(null)
    })

    it('is told the whole surface does not exist, and reaches no host method', async () => {
      // The old build cannot name the capability, so its clients never send it.
      expect(baseline.capabilities).not.toContain(STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY)
      for (const { method } of STRUCTURED_CALLS) {
        const replies = await callBuild(current, method, paramsFor(method), {
          clientKind: 'runtime',
          clientCapabilities: baseline.capabilities
        })
        expect(replies, `${method} must answer exactly once`).toHaveLength(1)
        expect(replies[0]).toMatchObject({
          ok: false,
          error: { message: expect.stringContaining('structured_agent_session_unsupported') }
        })
      }
      for (const [name, spy] of Object.entries(hostCalls)) {
        expect(spy, `${name} ran for a client without the capability`).not.toHaveBeenCalled()
      }
    })

    it('is served the same calls once it advertises the capability', async () => {
      for (const { method, hostMethod } of STRUCTURED_CALLS) {
        const replies = await callBuild(current, method, paramsFor(method), {
          clientKind: 'runtime',
          clientCapabilities: [
            ...baseline.capabilities,
            STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
          ]
        })
        // A subscription that opens with nothing to say answers with no reply at
        // all, so reaching the host is the signal that the gate opened.
        if (hostMethod) {
          expect(hostCalls[hostMethod], `${method} did not reach the host`).toHaveBeenCalled()
        } else {
          expect(replies[0], `${method} was refused`).toMatchObject({ ok: true })
        }
        for (const reply of replies) {
          expect(reply, `${method} was refused: ${JSON.stringify(reply)}`).toMatchObject({
            ok: true
          })
        }
      }
    })
  })

  describe('a new client against an old host', () => {
    it('finds no structured method registered on the old build', () => {
      expect(baseline.methodNames.filter((name) => name.startsWith('agentSession.'))).toEqual([])
      expect(current.methodNames.filter((name) => name.startsWith('agentSession.'))).toHaveLength(
        STRUCTURED_CALLS.length
      )
    })

    it('can detect the absence during negotiation instead of by calling', () => {
      expect(current.capabilities).toContain(STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY)
      expect(baseline.capabilities).not.toContain(STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY)
      // Additive surface: bumping the protocol number would strand every paired
      // device on this release rather than degrade one feature.
      expect(current.protocolVersion).toBe(baseline.protocolVersion)
    })

    it('gets a clean method_not_found from the old dispatcher rather than silence', async () => {
      for (const { method } of STRUCTURED_CALLS) {
        const replies = await callBuild(baseline, method, paramsFor(method), {
          clientKind: 'runtime',
          clientCapabilities: current.capabilities
        })
        expect(replies, `${method} must answer exactly once`).toHaveLength(1)
        expect(replies[0], `${method} on the old host`).toMatchObject({
          ok: false,
          error: { code: 'method_not_found' }
        })
      }
    })
  })

  describe('an old client against a structured-owned AI Vault row', () => {
    let root: string
    let store: AgentSessionRecordStore
    let runtime: Record<string, unknown>
    let createMobileSessionTerminal: ReturnType<typeof vi.fn>

    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), 'orca-cross-version-ai-vault-'))
      store = await AgentSessionRecordStore.open({
        directory: join(root, 'store'),
        hostId: 'local'
      })
      const host = new StructuredAgentSessionHost({
        store,
        adapter: {
          acquire: async ({ fence }) => ({
            process: {
              hostId: 'local',
              pid: 4242,
              processStartTimeMs: NOW,
              spawnToken: store.getRecord(SESSION)?.lease.reservedSpawnToken ?? 'spawn-vault'
            },
            link: {
              linkId: `link-${fence}`,
              handle: { provider: 'codex', threadId: THREAD },
              origin: 'created',
              mintedAtFence: fence,
              observedAt: NOW
            }
          }),
          dispatch: async () => ({ state: 'accepted' }),
          cancelTurn: async () => ({ cancelled: true }),
          answerPrompt: async () => undefined,
          setOption: async () => undefined
        },
        journalRoot: root,
        claimKeyId: 'key-1',
        mintSpawnToken: () => 'spawn-vault',
        now: () => NOW
      })
      setStructuredAgentSessionHost(host)
      const attached = await host.attach({ callerKey: 'test' }, attachParams(null) as never)
      expect(attached.ok).toBe(true)
      createMobileSessionTerminal = vi.fn()
      runtime = {
        ...(runtimeStub() as Record<string, unknown>),
        listAiVaultSessions: vi.fn(async () => ({
          sessions: [
            {
              id: `local:codex:${THREAD}:/home/dev/.codex/sessions/rollout-${THREAD}.jsonl`,
              executionHostId: 'local',
              agent: 'codex',
              sessionId: THREAD,
              title: 'Owned thread',
              cwd: '/repo',
              branch: null,
              model: null,
              filePath: `/home/dev/.codex/sessions/rollout-${THREAD}.jsonl`,
              codexHome: '/home/dev/.codex',
              createdAt: null,
              updatedAt: null,
              modifiedAt: '2026-08-11T00:00:00.000Z',
              messageCount: 1,
              totalTokens: 0,
              previewMessages: [],
              queuedMessageCount: 0,
              subagentTranscriptCount: 0,
              resumeCommand: `codex resume '${THREAD}'`,
              subagent: null
            }
          ],
          issues: [],
          scannedAt: '2026-08-11T00:00:00.000Z'
        })),
        prepareAiVaultSessionResume: vi.fn(),
        createMobileSessionTerminal
      }
    })

    afterEach(async () => {
      setStructuredAgentSessionHost(null)
      await rm(root, { recursive: true, force: true })
    })

    it('hides the row from the old client and annotates it for a capable client', async () => {
      const oldReply = (
        await callBuild(
          current,
          'aiVault.listSessions',
          {},
          {
            clientKind: 'runtime',
            clientCapabilities: baseline.capabilities
          },
          runtime
        )
      )[0]
      expect(oldReply).toMatchObject({ ok: true, result: { sessions: [] } })

      const capableReply = (
        await callBuild(
          current,
          'aiVault.listSessions',
          {},
          {
            clientKind: 'runtime',
            clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
          },
          runtime
        )
      )[0]
      expect(capableReply).toMatchObject({
        ok: true,
        result: {
          sessions: [
            {
              structuredSession: { sessionId: SESSION, workspaceId: WORKSPACE }
            }
          ]
        }
      })
    })

    it('refuses cached prepare and both legacy launch deliveries before a second writer starts', async () => {
      const params = {
        agent: 'codex',
        filePath: `/home/dev/.codex/sessions/rollout-${THREAD}.jsonl`,
        codexHome: '/home/dev/.codex'
      }
      expect(
        (
          await callBuild(
            current,
            'aiVault.prepareSessionResume',
            params,
            {
              clientKind: 'runtime',
              clientCapabilities: baseline.capabilities
            },
            runtime
          )
        )[0]
      ).toMatchObject({ ok: false, error: { code: 'agent_session_conflict' } })

      expect(
        (
          await callBuild(
            current,
            'session.tabs.createTerminal',
            { worktree: `id:${WORKSPACE}`, command: `codex resume '${THREAD}'` },
            { clientKind: 'runtime', clientCapabilities: baseline.capabilities },
            runtime
          )
        )[0]
      ).toMatchObject({ ok: false, error: { code: 'agent_session_conflict' } })
      expect(
        (
          await callBuild(
            current,
            'terminal.send',
            { terminal: 'terminal-1', text: `codex resume '${THREAD}'`, enter: true },
            { clientKind: 'runtime', clientCapabilities: baseline.capabilities },
            runtime
          )
        )[0]
      ).toMatchObject({ ok: false, error: { code: 'agent_session_conflict' } })
      expect(createMobileSessionTerminal).not.toHaveBeenCalled()
    })
  })

  describe('a cursor across a host restart', () => {
    let root: string
    let store: AgentSessionRecordStore
    let runtime: unknown

    /** Phase 2 owns provider processes; the adapter is the only stub here. */
    function adapter(): StructuredAgentSessionAdapter {
      return {
        acquire: async ({ fence }) => ({
          process: {
            hostId: 'local',
            pid: 4242,
            processStartTimeMs: 1_700_000_000_000,
            spawnToken: store.getRecord(SESSION)?.lease.reservedSpawnToken ?? 'spawn-a'
          },
          link: {
            linkId: `link-${fence}`,
            handle: { provider: 'codex', threadId: THREAD },
            // A restarted host re-proves the thread it inherited; only the first
            // owner of a session may claim to have created it.
            origin: store.getRecord(SESSION)?.providerHandleChain.length ? 'resumed' : 'created',
            mintedAtFence: fence,
            observedAt: NOW
          }
        }),
        dispatch: async () => ({
          state: 'accepted',
          providerIdentity: { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal: 1 }
        }),
        cancelTurn: async () => ({ cancelled: true }),
        answerPrompt: async () => undefined,
        setOption: async () => undefined
      }
    }

    /** Reopens the store from disk and installs a fresh host over the same journal
     *  root — what a process restart actually leaves behind. */
    async function bootHost(generation: string): Promise<StructuredAgentSessionHost> {
      store = await AgentSessionRecordStore.open({
        directory: join(root, 'store'),
        hostId: 'local'
      })
      const host = new StructuredAgentSessionHost({
        store,
        adapter: adapter(),
        journalRoot: root,
        claimKeyId: 'key-1',
        mintSpawnToken: () => `spawn-${generation}`,
        // The provider died with the host that spawned it, which is what makes
        // the restarted host the legitimate next writer.
        probeOwner: async () => ({ outcome: 'pid-absent' }),
        now: () => NOW
      })
      setStructuredAgentSessionHost(host)
      return host
    }

    type HostAnswer = {
      ok: boolean
      fence: number
      cursor: { epoch: string; sequence: number }
      refusal?: { code: string; currentFence?: number }
    }

    /** Reattaching after a restart: the client's fence died with the previous
     *  host, and the refusal that says so is what hands it the live one. */
    async function reattach(staleFence: number): Promise<HostAnswer> {
      const refused = await answer('agentSession.ensure', attachParams(staleFence))
      expect(refused).toMatchObject({
        ok: false,
        refusal: { code: 'agent_session_checkpoint_stale' }
      })
      const currentFence = refused.refusal?.currentFence
      expect(currentFence).toBeGreaterThan(staleFence)
      const reattached = await answer('agentSession.ensure', attachParams(currentFence ?? 0))
      expect(reattached).toMatchObject({ ok: true })
      return reattached
    }

    async function call(method: string, params: unknown): Promise<RpcReply[]> {
      return callBuild(
        current,
        method,
        params,
        {
          clientKind: 'runtime',
          clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY],
          clientId: 'paired-device-1',
          connectionId: 'connection-1'
        },
        runtime
      )
    }

    /** The host's own answer, which carries its refusals inside a successful RPC. */
    async function answer(method: string, params: unknown): Promise<HostAnswer> {
      const reply = (await call(method, params))[0]
      if (!reply?.ok) {
        throw new Error(`${method} failed at the wire: ${JSON.stringify(reply?.error ?? reply)}`)
      }
      return reply.result as HostAnswer
    }

    beforeEach(async () => {
      operations = 0
      root = await mkdtemp(join(tmpdir(), 'orca-cross-version-agent-session-'))
      runtime = runtimeStub()
      await bootHost('a')
    })

    afterEach(async () => {
      setStructuredAgentSessionHost(null)
      await rm(root, { recursive: true, force: true })
    })

    it('resumes from the cursor the client held, with no snapshot and no replay', async () => {
      const created = await answer('agentSession.create', createIntentParams())
      expect(created.ok).toBe(true)
      const first = await answer('agentSession.send', sendParams('before restart', created.fence))
      expect(first.ok).toBe(true)
      const held = first.cursor

      const restarted = await bootHost('b')
      await restarted.restoreReadableSessions()
      // Restart restores the session for READING. The chat the client still has open takes its
      // hold, and that is what gives the session a provider child again.
      await answer('agentSession.hold', { sessionId: SESSION, holderId: 'surface-1' })
      const resumedFence = store.getRecord(SESSION)?.lease.runtimeFence ?? 0
      expect(resumedFence).toBeGreaterThan(created.fence)
      const second = await answer('agentSession.send', sendParams('after restart', resumedFence))
      expect(second.ok).toBe(true)

      const events = (
        await call('agentSession.subscribe', { sessionId: SESSION, cursor: held })
      ).map((reply) => reply.result as AgentSessionSubscribeEvent)
      expect(events.map((event) => event.type)).toEqual(['batch'])
      const batch = events[0]?.type === 'batch' ? events[0].batch : null
      const rendered = JSON.stringify(batch?.items ?? [])
      expect(rendered).toContain('after restart')
      // Everything the client already had stays out of the resume.
      expect(rendered).not.toContain('before restart')
      expect(batch?.cursor.epoch).toBe(held.epoch)
      expect(batch?.cursor.sequence).toBeGreaterThan(held.sequence)
    })

    it('refuses a write still fenced to the host generation that died', async () => {
      const created = await answer('agentSession.create', createIntentParams())
      await bootHost('b')
      const reattached = await reattach(created.fence)
      expect(reattached.fence).toBeGreaterThan(created.fence)

      expect(await answer('agentSession.send', sendParams('stale', created.fence))).toMatchObject({
        ok: false,
        refusal: { code: 'agent_session_checkpoint_stale' }
      })
    })
  })
})
