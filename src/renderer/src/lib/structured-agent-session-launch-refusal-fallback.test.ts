// @vitest-environment happy-dom

// The duplicate-session guard: which create refusals may open a legacy terminal beside the chat.
// Deliberately exercises the real `launch-structured-agent-session`, because the classification
// under test lives there — mocking it out would assert nothing.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-session-contracts'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-client'

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  refresh: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), message: vi.fn() }
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, options?: { value0?: string }) =>
    fallback.replace('{{value0}}', options?.value0 ?? '')
}))

vi.mock('@/lib/agent-catalog', () => ({
  getAgentCatalog: () => [{ id: 'codex', label: 'Codex' }]
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

vi.mock('@/runtime/local-structured-session-tabs-sync', () => ({
  LOCAL_STRUCTURED_SESSION_OWNER: 'local',
  refreshLocalStructuredSessionTabs: mocks.refresh
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({ unifiedTabsByWorktree: {} }),
    subscribe: () => () => {}
  }
}))

import {
  StructuredAgentSessionCreateRefusalError,
  StructuredAgentSessionCreateUnknownOutcomeError
} from '@/lib/launch-structured-agent-session'
import {
  getStructuredAgentLaunchStatus,
  startStructuredAgentLaunch
} from './structured-agent-session-launch'

type CreateReply = { ok: boolean; refusal?: { code: string; message: string } }

/** Replies to every `agentSession.create` in turn, repeating the last reply thereafter. */
function replyToCreates(...replies: CreateReply[]): void {
  let index = 0
  mocks.call.mockImplementation(async (_target: unknown, method: string, params: unknown) => {
    if (method !== 'agentSession.create') {
      return { ok: true, page: { fence: 1 } }
    }
    const reply = replies[Math.min(index, replies.length - 1)]
    index += 1
    if (!reply.ok) {
      return reply
    }
    const sessionId = (params as { envelope: { sessionId: string } }).envelope.sessionId
    return { ok: true, replayed: index > 1, fence: 1, value: { sessionId, fence: 1 } }
  })
}

function refused(code: string): CreateReply {
  return { ok: false, refusal: { code, message: `create refused: ${code}` } }
}

function publishedSnapshot(worktreeId: string, sessionId: string): RuntimeMobileSessionTabsResult {
  return {
    worktree: worktreeId,
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs: [
      {
        type: 'agent-session',
        id: 'tab-1',
        title: 'Codex',
        sessionId,
        agent: 'codex',
        isActive: true
      }
    ]
  }
}

async function flushLaunchSettlement(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve()
  }
}

describe('legacy terminal fallback after a refused structured create', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    mocks.refresh.mockResolvedValue([])
  })

  it.each(['agent_session_operation_unknown', 'agent_session_ownership_unknown'])(
    'opens no sibling terminal when the host answers %s',
    async (code) => {
      const worktreeId = `wt-${code}`
      const legacyTerminals: string[] = []
      replyToCreates(refused(code))

      const launch = startStructuredAgentLaunch(worktreeId, 'codex')
      void launch.claimDefinitiveRefusalFallback(() => {
        legacyTerminals.push('legacy-terminal')
      })

      await expect(launch.launchResult).rejects.toBeInstanceOf(
        StructuredAgentSessionCreateUnknownOutcomeError
      )
      await flushLaunchSettlement()

      // The host may already hold the session, so the user keeps exactly one thing: no chat it
      // could confirm, and no terminal beside a session it could not rule out.
      expect(legacyTerminals).toEqual([])
      expect(launch.isVisibilityUnknown()).toBe(true)
      expect(toast.error).toHaveBeenCalledOnce()
    }
  )

  it('adopts the session an unknown outcome had already created, without a sibling', async () => {
    const worktreeId = 'wt-unknown-then-published'
    const legacyTerminals: string[] = []
    replyToCreates(refused('agent_session_operation_unknown'), { ok: true })

    const launch = startStructuredAgentLaunch(worktreeId, 'codex')
    const fallbackRan = launch.claimDefinitiveRefusalFallback(() => {
      legacyTerminals.push('legacy-terminal')
    })
    mocks.refresh
      .mockResolvedValueOnce([])
      .mockResolvedValue([publishedSnapshot(worktreeId, launch.sessionId)])

    await expect(launch.launchResult).resolves.toEqual({
      sessionId: launch.sessionId,
      fence: 1
    })
    await expect(fallbackRan).resolves.toBe(false)
    await flushLaunchSettlement()

    expect(legacyTerminals).toEqual([])
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('opens exactly one legacy terminal when the refusal is on the definitive allowlist', async () => {
    const worktreeId = 'wt-unsupported'
    const legacyTerminals: string[] = []
    replyToCreates(refused('structured_agent_session_unsupported'))

    const launch = startStructuredAgentLaunch(worktreeId, 'codex')
    const fallbackRan = launch.claimDefinitiveRefusalFallback(() => {
      legacyTerminals.push('legacy-terminal')
    })

    await expect(launch.launchResult).rejects.toBeInstanceOf(
      StructuredAgentSessionCreateRefusalError
    )
    await expect(fallbackRan).resolves.toBe(true)
    await flushLaunchSettlement()

    expect(legacyTerminals).toEqual(['legacy-terminal'])
    // A proven "nothing was created" needs no replay, so the terminal is the only surface open.
    expect(
      mocks.call.mock.calls.filter(([, method]) => method === 'agentSession.create')
    ).toHaveLength(1)
    expect(launch.isVisibilityUnknown()).toBe(false)
  })

  it('opens exactly one legacy terminal when an older runtime has no create method', async () => {
    const legacyTerminals: string[] = []
    mocks.call.mockRejectedValue(
      new RuntimeRpcCallError({
        id: 'rpc-old-runtime',
        ok: false,
        error: { code: 'method_not_found', message: 'Unknown method: agentSession.create' }
      })
    )

    const launch = startStructuredAgentLaunch('wt-old-runtime', 'codex')
    const fallbackRan = launch.claimDefinitiveRefusalFallback(() => {
      legacyTerminals.push('legacy-terminal')
    })

    await expect(launch.launchResult).rejects.toBeInstanceOf(
      StructuredAgentSessionCreateRefusalError
    )
    await expect(fallbackRan).resolves.toBe(true)
    expect(legacyTerminals).toEqual(['legacy-terminal'])
    expect(mocks.call).toHaveBeenCalledOnce()
    expect(getStructuredAgentLaunchStatus('wt-old-runtime', 'codex')).toBe('idle')
  })
})
