// Check released stop-note projection and cursor resume after reopening disk state in one process.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { StructuredAgentSessionAdapter } from '../../../src/main/native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import { StructuredAgentSessionHost } from '../../../src/main/native-chat/agent-session-wire/host/structured-agent-session-host'
import { startsWhenPublished } from '../../../src/main/native-chat/agent-session-wire/host/testing/structured-agent-session-instant-start.test-fixture'
import { setStructuredAgentSessionHost } from '../../../src/main/native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { AgentSessionRecordStore } from '../../../src/main/runtime/agent-session/records/agent-session-record-store'
import {
  openTestAgentSessionRecordStore,
  openTestAgentSessionDatabase,
  closeTestAgentSessionDatabase
} from '../../../src/main/runtime/agent-session/records/agent-session-record-store-test-harness'
import type { AgentSessionSubscribeEvent } from '../../../src/shared/agent-session/agent-session-wire'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../src/shared/agent-session/agent-session-runtime-capabilities'

import { callBuild, runtimeStub } from './structured-agent-session-surface-execution'

import {
  createIntentParams,
  NOW,
  resetOperationIds,
  sendParams,
  SESSION,
  THREAD
} from './structured-agent-session-surface-manifest'
import {
  loadAgentSessionWireBuild,
  WORKING_TREE,
  type AgentSessionWireBuild,
  type RpcReply
} from './versioned-agent-session-wire'
import * as journalHostDatabase from '../../../src/main/native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'
import { createStructuredAgentSessionLogger } from '../../../src/main/native-chat/agent-session-wire/host/structured-agent-session-logger'
import { codexProviderHandle } from '../../../src/shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import { NO_STRUCTURED_AGENTS } from '../../../src/main/native-chat/agent-session-wire/providers/testing/structured-agent-session-adapter-router.test-fixture'
import { describeReleasedStopNoteProjection } from './cross-version-stop-note-scenarios'

const SUITE_TIMEOUT_MS = 180_000

describeReleasedStopNoteProjection({
  build: () => current,
  callBuild,
  runtimeStub
})

let current: AgentSessionWireBuild

beforeAll(async () => {
  current = await loadAgentSessionWireBuild(WORKING_TREE)
}, SUITE_TIMEOUT_MS)

async function releaseHostRoot(root: string): Promise<void> {
  setStructuredAgentSessionHost(null)
  await journalHostDatabase.closeTestJournalHostDatabase(root)
  await rm(root, { recursive: true, force: true })
}

describe('cross-version structured agent sessions', () => {
  describe('a cursor across a host restart', () => {
    let root: string
    let store: AgentSessionRecordStore
    let runtime: unknown

    /** Holds a provider start open, so a reply's timing can be read against it. */
    let startGate: Promise<void> = Promise.resolve()
    let ownerProbeGate: Promise<void> = Promise.resolve()
    let runningHost: StructuredAgentSessionHost | undefined
    /** Holds a published child's handshake: it proves its start only once this settles. */
    let handshake: Promise<void> = Promise.resolve()
    let starts = 0

    // Stub only provider acquisition; published adapters prove start after their handshake.
    function adapter(host: () => StructuredAgentSessionHost): StructuredAgentSessionAdapter {
      return startsWhenPublished(
        {
          // Supply supportsCreate like real adapters, or missing fake capabilities would refuse location before the tested gate.
          supportsCreate: () => true,
          open: async () => {
            await handshake
            return { reportedOptions: { model: '' } }
          },
          acquire: async ({ fence }) => {
            starts += 1
            await startGate
            return {
              acquisitionGeneration: `cursor-${fence}`,
              process: {
                hostId: 'local',
                pid: 4242,
                processStartTimeMs: 1_700_000_000_000,
                spawnToken: store.getRecord(SESSION)?.lease.reservedSpawnToken ?? 'spawn-a'
              },
              link: {
                linkId: `link-${fence}`,
                handle: codexProviderHandle(THREAD),
                // A restarted host re-proves the thread it inherited; only the first
                // owner of a session may claim to have created it.
                origin: store.getRecord(SESSION)?.providerHandleChain.length
                  ? 'resumed'
                  : 'created',
                mintedAtFence: fence,
                observedAt: NOW
              }
            }
          },
          dispatch: async () => ({
            state: 'accepted',
            providerIdentity: {
              provider: 'codex',
              threadId: THREAD,
              turnId: 'turn-1',
              ordinal: 1
            }
          }),
          cancelTurn: async () => ({ cancelled: true }),
          answerPrompt: async () => undefined,
          setOption: async () => undefined
        },
        host
      )
    }

    // Reopen disk state under a fresh host, preserving the journal root as a real process restart does.
    async function bootHost(generation: string, startupLimits?: { ceilingMs: number }) {
      await runningHost?.flushAllStreamedEvents()
      await closeTestAgentSessionDatabase(root)
      store = await openTestAgentSessionRecordStore(root)
      const host: StructuredAgentSessionHost = new StructuredAgentSessionHost({
        agents: NO_STRUCTURED_AGENTS,
        logger: createStructuredAgentSessionLogger(),
        store,
        adapter: adapter(() => host),
        journalDatabase: await openTestAgentSessionDatabase(root),
        claimKeyId: 'key-1',
        mintSpawnToken: () => `spawn-${generation}`,
        // The provider died with the host that spawned it, which is what makes
        // the restarted host the legitimate next writer.
        probeOwner: async () => {
          await ownerProbeGate
          return { outcome: 'pid-absent' }
        },
        now: () => NOW,
        ...(startupLimits ? { startupLimits } : {})
      })
      setStructuredAgentSessionHost(host)
      runningHost = host
      return host
    }

    type HostAnswer = {
      ok: boolean
      fence: number
      cursor: { epoch: string; sequence: number }
      refusal?: { code: string; currentFence?: number }
    }

    async function call<Result = unknown>(
      method: string,
      params: unknown,
      clientCapabilities: readonly string[] = [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY],
      onReply?: (reply: RpcReply<Result>) => void
    ): Promise<RpcReply<Result>[]> {
      return callBuild(
        current,
        method,
        params,
        {
          clientKind: 'runtime',
          clientCapabilities,
          clientId: 'paired-device-1',
          connectionId: 'connection-1'
        },
        runtime,
        onReply
      )
    }

    /** The host's own answer, which carries its refusals inside a successful RPC. */
    async function answer(method: string, params: unknown): Promise<HostAnswer> {
      const reply = (await call<HostAnswer>(method, params))[0]
      if (!reply?.ok) {
        throw new Error(`${method} failed at the wire: ${JSON.stringify(reply?.error ?? reply)}`)
      }
      if (!reply.result) {
        throw new Error(`${method} returned no host answer`)
      }
      return reply.result
    }

    beforeEach(async () => {
      resetOperationIds()
      startGate = Promise.resolve()
      ownerProbeGate = Promise.resolve()
      runningHost = undefined
      handshake = Promise.resolve()
      root = await mkdtemp(join(tmpdir(), 'orca-cross-version-agent-session-'))
      runtime = runtimeStub()
      await bootHost('a')
    })

    afterEach(() => releaseHostRoot(root))

    it('resumes from the cursor the client held, with no snapshot and no replay', async () => {
      const created = await answer('agentSession.create', createIntentParams())
      expect(created.ok).toBe(true)
      const first = await answer('agentSession.send', sendParams('before restart', created.fence))
      expect(first.ok).toBe(true)
      const held = first.cursor

      const restarted = await bootHost('b')
      await restarted.seedSessionTabs([SESSION])
      await restarted.revealSession(SESSION)
      // Demand-open restores reading; the retained chat's hold starts its provider child again.
      await answer('agentSession.hold', {
        sessionId: SESSION,
        holderId: 'surface-1'
      })
      const resumedFence = store.getRecord(SESSION)?.lease.runtimeFence ?? 0
      expect(resumedFence).toBeGreaterThan(created.fence)
      const second = await answer('agentSession.send', sendParams('after restart', resumedFence))
      expect(second.ok).toBe(true)

      const restated = Promise.withResolvers<void>()
      const replies = await call<AgentSessionSubscribeEvent>(
        'agentSession.subscribe',
        { sessionId: SESSION, cursor: held },
        undefined,
        (reply) => {
          const event = reply.result
          if (!reply.ok || event?.type !== 'batch') {
            restated.reject(new Error(`cursor resume failed: ${JSON.stringify(reply)}`))
          } else if (
            event.batch.cursor.sequence > held.sequence &&
            event.batch.items.length === 0 &&
            event.batch.removedItemIds.length === 0 &&
            event.batch.submissions.length === 0 &&
            event.working !== undefined
          ) {
            restated.resolve()
          }
        }
      )
      await restated.promise
      const events = replies.map((reply) => {
        if (!reply.ok || !reply.result) {
          throw new Error(`cursor resume failed: ${JSON.stringify(reply)}`)
        }
        return reply.result
      })
      // A roster-only publication may precede catch-up while its initial capture is superseded.
      if (events[0]?.type === 'batch' && events[0].batch.cursor.sequence === held.sequence) {
        expect(events.shift()).toEqual({
          type: 'batch',
          sessionId: SESSION,
          batch: { cursor: held, items: [], removedItemIds: [], submissions: [] },
          fence: store.getConversation(SESSION)?.currentFence,
          backgroundTasks: null,
          commands: null,
          hostNow: expect.any(Number)
        })
      }
      expect(events.map((event) => event.type)).toEqual(['batch', 'batch'])
      const batches = events.filter((event) => event.type === 'batch')
      const batch = batches[0]?.batch
      const rendered = JSON.stringify(batches.flatMap((event) => event.batch.items))
      expect(rendered).toContain('after restart')
      // Everything the client already had stays out of the resume.
      expect(rendered).not.toContain('before restart')
      expect(batch?.cursor.epoch).toBe(held.epoch)
      expect(batch?.cursor.sequence).toBeGreaterThan(held.sequence)
      expect(batches[1]?.batch).toEqual({
        cursor: batch?.cursor,
        items: [],
        removedItemIds: [],
        submissions: []
      })
    })

    // Every released client still sends the fence it last saw; this host names a write by its
    // target and ignores that fence. Only the attach keeps comparing one, which `reattach` pins.

    // Legacy clients cannot show rejection after pending; answer after handoff, while accepted-send clients may answer before provider start.

    // Unproven starts return the person's message to the queue instead of leaving a legacy RPC waiting.
  })
})
