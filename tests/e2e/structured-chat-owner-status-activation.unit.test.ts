// A chat whose agent is not running still owns its conversation. Released desktop clients gate
// worktree activation on the host's owner answer, so a chat at rest that answered anything but
// `native` blocked the gate, which then skips adopting and resuming the worktree's paneless agents.
// This drives the real host's answer through the desktop's activation gate for the two ways a chat
// comes to rest.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { StructuredAgentSessionAdapter } from '../../src/main/native-chat/agent-session-wire/structured-agent-session-adapter'
import { StructuredAgentSessionHost } from '../../src/main/native-chat/agent-session-wire/structured-agent-session-host'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams,
  resetHostTestOperationIds
} from '../../src/main/native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { AgentSessionRecordStore } from '../../src/main/runtime/agent-session-record-store'
import { useAppStore } from '../../src/renderer/src/store'
import { runWorktreeAgentActivationGate } from '../../src/renderer/src/lib/worktree-agent-activation-gate'
import { readWorktreeStructuredActivationInventory } from '../../src/renderer/src/lib/worktree-agent-structured-inventory'
import type { RuntimeMobileSessionTabsResult } from '../../src/shared/runtime-types'

const WORKTREE = 'repo-1::/workspace/repo'
const SURFACE = 'desktop-chat:1'

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let closeSession: Mock<NonNullable<StructuredAgentSessionAdapter['closeSession']>>

function openHost(): void {
  host = new StructuredAgentSessionHost({
    store,
    adapter: {
      acquire: async ({ fence, spawnToken }) => ({
        process: { hostId: 'local', pid: 4242, processStartTimeMs: 1_700_000_000_000, spawnToken },
        link: {
          linkId: `link-${fence}`,
          handle: { provider: 'codex', threadId: THREAD },
          origin: store.getRecord(SESSION)?.providerHandleChain.length ? 'resumed' : 'created',
          mintedAtFence: fence,
          observedAt: NOW
        }
      }),
      closeSession,
      releaseAcquisition: async () => true,
      dispatch: async () => ({ state: 'rejected', reason: 'unused' }),
      cancelTurn: async () => ({ cancelled: false }),
      answerPrompt: async () => undefined,
      setOption: async () => undefined
    },
    journalRoot: root,
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-a',
    releaseGraceMs: 5,
    probeOwner: async () => ({ outcome: 'pid-absent' }),
    now: () => NOW
  })
}

/** The desktop's runtime bridge, answering the two reads the gate makes from the real host. */
function serveDesktopRuntime(): void {
  const tabs: RuntimeMobileSessionTabsResult = {
    worktree: WORKTREE,
    publicationEpoch: 'owner-status-test',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs: [
      {
        type: 'agent-session',
        id: `structured-agent-session-${SESSION}`,
        title: 'Codex Chat',
        sessionId: SESSION,
        agent: 'codex',
        isActive: false
      }
    ]
  }
  const call = async ({ method, params }: { method: string; params: { sessionId?: string } }) => {
    if (method === 'session.tabs.list') {
      return { ok: true, result: tabs }
    }
    if (method === 'agentSession.handoffStatus') {
      try {
        return { ok: true, result: host.handoffStatus(params.sessionId ?? '') }
      } catch (error) {
        return { ok: false, error: { code: String(error), message: String(error) } }
      }
    }
    throw new Error(`Unexpected runtime method: ${method}`)
  }
  vi.stubGlobal('window', { api: { runtime: { call } } })
}

function activate(): ReturnType<typeof runWorktreeAgentActivationGate> {
  return runWorktreeAgentActivationGate(WORKTREE, {
    getState: () => useAppStore.getState(),
    listSessions: async () => [],
    listSurfaceOwners: async () => null,
    hasStructuredSession: readWorktreeStructuredActivationInventory,
    resume: () => 0
  })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-owner-status-'))
  resetHostTestOperationIds()
  closeSession = vi.fn(async () => true)
  store = await AgentSessionRecordStore.open({ directory: join(root, 'store'), hostId: 'local' })
  openHost()
  expect(await host.attach({ callerKey: 'client-1' }, hostTestAttachParams(null))).toMatchObject({
    ok: true
  })
  serveDesktopRuntime()
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

describe('a chat at rest keeps its worktree activatable', () => {
  it('after idle release forgot the session', async () => {
    await host.hold(SESSION, SURFACE)
    host.release(SESSION, SURFACE)
    await vi.waitFor(() => expect(host.hasSession(SESSION)).toBe(false))
    expect(closeSession).toHaveBeenCalledWith(SESSION)

    expect(host.handoffStatus(SESSION)).toMatchObject({ owner: 'native' })
    expect(await activate()).toBe('structured')
  })

  it('after an app restart restored it for reading', async () => {
    await host.flushAllStreamedEvents()
    store = await AgentSessionRecordStore.open({ directory: join(root, 'store'), hostId: 'local' })
    openHost()
    await host.restoreReadableSessions()
    expect(host.hasSession(SESSION)).toBe(true)
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'released',
      ownerProcess: null
    })

    expect(host.handoffStatus(SESSION)).toMatchObject({ owner: 'native' })
    expect(await activate()).toBe('structured')
  })
})
