// Check released stop-note projection and cursor resume after reopening disk state in one process.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { StructuredAgentSessionAdapter } from '../../../src/main/native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import { StructuredAgentSessionHost } from '../../../src/main/native-chat/agent-session-wire/host/structured-agent-session-host'
import { emptyAgentSessionBatch } from '../../../src/main/native-chat/agent-session-wire/publication/subscribers/agent-session-empty-batch'
import { startsWhenPublished } from '../../../src/main/native-chat/agent-session-wire/host/testing/structured-agent-session-instant-start.test-support'
import { setStructuredAgentSessionHost } from '../../../src/main/native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { AgentSessionRecordStore } from '../../../src/main/runtime/agent-session/records/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../../src/main/runtime/agent-session/records/agent-session-record-store-test-harness'
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
import { NO_STRUCTURED_AGENTS } from '../../../src/main/native-chat/agent-session-wire/providers/testing/structured-agent-session-adapter-router-test-support'
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

    // Reopen disk state under a fresh host within this process.
    async function bootHost(generation: string, startupLimits?: { ceilingMs: number }) {
      store = await openTestAgentSessionRecordStore(root)
      const host: StructuredAgentSessionHost = new StructuredAgentSessionHost({
        agents: NO_STRUCTURED_AGENTS,
        logger: createStructuredAgentSessionLogger(),
        store,
        adapter: adapter(() => host),
        journalDatabase: journalHostDatabase.openTestJournalHostDatabase(root),
        claimKeyId: 'key-1',
        mintSpawnToken: () => `spawn-${generation}`,
        // The provider died with the host that spawned it, which is what makes
        // the restarted host the legitimate next writer.
        probeOwner: async () => ({ outcome: 'pid-absent' }),
        now: () => NOW,
        ...(startupLimits ? { startupLimits } : {})
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

    async function call(
      method: string,
      params: unknown,
      clientCapabilities: readonly string[] = [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
    ): Promise<RpcReply[]> {
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
      resetOperationIds()
      startGate = Promise.resolve()
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

      const events = (
        await call('agentSession.subscribe', {
          sessionId: SESSION,
          cursor: held
        })
      ).map((reply) => reply.result as AgentSessionSubscribeEvent)
      expect(events.map((event) => event.type)).toEqual(['batch', 'batch'])
      const batches = events.filter((event) => event.type === 'batch')
      const batch = batches[0]?.batch
      const rendered = JSON.stringify(batches.flatMap((event) => event.batch.items))
      expect(rendered).toContain('after restart')
      // Everything the client already had stays out of the resume.
      expect(rendered).not.toContain('before restart')
      expect(batch?.cursor.epoch).toBe(held.epoch)
      expect(batch?.cursor.sequence).toBeGreaterThan(held.sequence)
      expect(batches[1]?.batch).toEqual(emptyAgentSessionBatch(batch?.cursor ?? held))
    })
  })
})
