// @vitest-environment happy-dom

// Launch coalescing when a launch adopts a conversation. Drives the real intent builder, because
// the identity under test is derived there — mocking it out would assert only the mock's shape.

import type { AgentLaunchProfile } from '../../../shared/agent-launch-profile'
import { createStructuredAgentSessionLaunchIntent } from './launch-structured-agent-session'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StructuredAgentSessionCreateParams } from '../../../shared/structured-agent-session-create'

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  seedDraft: vi.fn(),
  refresh: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), message: vi.fn() }
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
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
    getState: () => ({
      unifiedTabsByWorktree: {},
      seedNativeChatLaunchDraft: mocks.seedDraft,
      repos: [{ id: 'repo', connectionId: null }],
      worktreesByRepo: {
        repo: ['claude', 'codex'].map((agent) => ({
          id: `wt-profile-${agent}`,
          repoId: 'repo',
          hostId: 'local'
        }))
      }
    }),
    subscribe: () => () => {}
  }
}))

import {
  getStructuredAgentLaunchStatus,
  getStructuredAgentSessionLaunchResumes,
  startStructuredAgentLaunch
} from './structured-agent-session-launch'

/** The create is dispatched off a microtask, so every assertion on it has to drain them first. */
async function flushLaunchDispatch(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve()
  }
}

/** Every create is left in flight, so each launch is still pending when the next one arrives. */
function createParams(): StructuredAgentSessionCreateParams[] {
  return mocks.call.mock.calls
    .filter(([, method]) => method === 'agentSession.create')
    .map(([, , params]) => params as StructuredAgentSessionCreateParams)
}

describe('a launch that adopts a conversation is its own identity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    mocks.refresh.mockResolvedValue([])
    mocks.call.mockImplementation(async (_target: unknown, method: string) => {
      if (method === 'agentSession.create') {
        return new Promise(() => {})
      }
      // Both providers now ask the executing host before creating.
      if (method === 'agentSession.createSupport') {
        return { supported: true }
      }
      return { ok: true, value: { submission: { dispatchState: 'accepted' } } }
    })
  })

  it.each(['claude', 'codex'] as const)(
    'keeps %s profile A/B pending independently through the actual intent builder',
    async (agent) => {
      vi.stubGlobal('navigator', { userAgent: 'Linux' })
      const worktreeId = `wt-profile-${agent}`
      const a: AgentLaunchProfile = {
        id: 'a',
        name: 'Original A',
        agent,
        hostId: 'local',
        executable: `/bin/${agent}`,
        binding: { kind: 'managed', accountId: 'a' }
      }
      const b: AgentLaunchProfile = {
        ...a,
        id: 'b',
        name: 'Original B',
        binding: { kind: 'managed', accountId: 'b' }
      }
      const first = startStructuredAgentLaunch(worktreeId, agent, {
        requestId: 'profile-click-a',
        agentProfile: a,
        prompt: 'first draft',
        promptDelivery: 'draft'
      })
      expect(getStructuredAgentLaunchStatus(worktreeId, agent, a)).toBe('pending')
      expect(() =>
        startStructuredAgentLaunch(worktreeId, agent, {
          requestId: 'profile-paired-refusal',
          agentProfile: a,
          executionHostId: 'runtime:server-1'
        })
      ).toThrow(/local terminal/)
      expect(getStructuredAgentLaunchStatus(worktreeId, agent, b)).toBe('idle')
      const second = startStructuredAgentLaunch(worktreeId, agent, {
        requestId: 'profile-click-a',
        agentProfile: b
      })
      const joined = startStructuredAgentLaunch(worktreeId, agent, {
        requestId: 'profile-click-a',
        agentProfile: { ...a, name: 'Renamed' }
      })
      await flushLaunchDispatch()
      expect(first.sessionId).not.toBe(second.sessionId)
      expect(joined.sessionId).toBe(first.sessionId)
      expect(createParams().map((params) => params.agentProfileId)).toEqual(['a', 'b'])
      expect(mocks.call).toHaveBeenCalledWith(
        { kind: 'local' },
        'agentSession.createSupport',
        expect.objectContaining({ agentProfileId: 'a' })
      )
      expect(getStructuredAgentLaunchStatus(worktreeId, agent)).toBe('idle')
      const nextAction = startStructuredAgentLaunch(worktreeId, agent, {
        requestId: 'new-profile-action',
        agentProfile: a,
        prompt: 'next draft',
        promptDelivery: 'draft'
      })
      expect(nextAction.sessionId).not.toBe(first.sessionId)
      await flushLaunchDispatch()
      expect(createParams().map((params) => params.agentProfileId)).toEqual(['a', 'b', 'a'])
      expect(mocks.seedDraft).toHaveBeenCalledTimes(2)
      a.name = 'Changed after click'
      expect(localStorage.getItem('orca:structuredAgentLaunches:v1')).toContain('Original A')
      expect(localStorage.getItem('orca:structuredAgentLaunches:v1')).not.toContain('Renamed')
      vi.unstubAllGlobals()
    }
  )

  it.each(['claude', 'codex'] as const)(
    'refuses an explicit paired target for a local %s profile before host admission',
    (agent) => {
      vi.stubGlobal('navigator', { userAgent: 'Linux' })
      try {
        expect(() =>
          createStructuredAgentSessionLaunchIntent(
            `wt-profile-${agent}`,
            agent,
            'runtime:server-1',
            undefined,
            undefined,
            {
              id: 'paired-refusal',
              name: 'Profile',
              agent,
              hostId: 'local',
              executable: `/bin/${agent}`,
              binding: { kind: 'managed', accountId: 'a' }
            }
          )
        ).toThrow(/local terminal/)
        expect(mocks.call).not.toHaveBeenCalled()
      } finally {
        vi.unstubAllGlobals()
      }
    }
  )

  it('does not hand a resume the blank launch already pending for the same worktree', async () => {
    // A joining caller is handed the EXISTING intent and contributes only its prompt, so joining
    // here would silently drop the adoption and open a blank chat instead.
    const worktreeId = 'wt-resume-vs-blank'
    const blank = startStructuredAgentLaunch(worktreeId, 'codex', { requestId: 'request-1' })
    const resume = startStructuredAgentLaunch(worktreeId, 'codex', {
      requestId: 'request-2',
      resumeFrom: { providerSessionId: 'thread-1' }
    })

    await flushLaunchDispatch()

    expect(resume.sessionId).not.toBe(blank.sessionId)
    // A resumed conversation may keep its own model, so its picker names no listed default.
    expect(getStructuredAgentSessionLaunchResumes(resume.sessionId)).toBe(true)
    expect(getStructuredAgentSessionLaunchResumes(blank.sessionId)).toBe(false)
    expect(createParams()).toEqual([
      expect.not.objectContaining({ resumeFrom: expect.anything() }),
      expect.objectContaining({ resumeFrom: { providerSessionId: 'thread-1' } })
    ])
  })

  it('does not hand a blank launch the resume already pending for the same worktree', async () => {
    const worktreeId = 'wt-blank-vs-resume'
    const resume = startStructuredAgentLaunch(worktreeId, 'codex', {
      requestId: 'request-3',
      resumeFrom: { providerSessionId: 'thread-1' }
    })
    const blank = startStructuredAgentLaunch(worktreeId, 'codex', { requestId: 'request-4' })

    await flushLaunchDispatch()

    expect(blank.sessionId).not.toBe(resume.sessionId)
    expect(createParams()).toHaveLength(2)
  })

  it('keeps two resumes of different rows apart', async () => {
    const worktreeId = 'wt-two-rows'
    const first = startStructuredAgentLaunch(worktreeId, 'codex', {
      requestId: 'request-5',
      resumeFrom: { providerSessionId: 'thread-1' }
    })
    const second = startStructuredAgentLaunch(worktreeId, 'codex', {
      requestId: 'request-6',
      resumeFrom: { providerSessionId: 'thread-2' }
    })

    await flushLaunchDispatch()

    expect(second.sessionId).not.toBe(first.sessionId)
    expect(createParams().map((params) => params.resumeFrom?.providerSessionId)).toEqual([
      'thread-1',
      'thread-2'
    ])
  })

  it('coalesces a duplicate click on the same row', async () => {
    const worktreeId = 'wt-same-row-twice'
    const resumeFrom = { providerSessionId: 'thread-1' }
    const first = startStructuredAgentLaunch(worktreeId, 'codex', {
      requestId: 'request-7',
      resumeFrom
    })
    const second = startStructuredAgentLaunch(worktreeId, 'codex', {
      requestId: 'request-8',
      resumeFrom
    })

    await flushLaunchDispatch()

    expect(second.sessionId).toBe(first.sessionId)
    expect(createParams()).toHaveLength(1)
  })

  it('keeps the same row apart across worktrees and agents', async () => {
    const resumeFrom = { providerSessionId: 'thread-1' }
    const here = startStructuredAgentLaunch('wt-here', 'codex', {
      requestId: 'request-9',
      resumeFrom
    })
    const there = startStructuredAgentLaunch('wt-there', 'codex', {
      requestId: 'request-10',
      resumeFrom
    })

    await flushLaunchDispatch()

    expect(there.sessionId).not.toBe(here.sessionId)
    expect(createParams()).toHaveLength(2)
  })

  it('reports a pending resume as a launch in flight for the worktree', () => {
    // "Is a chat starting here" means any launch for the pair, not only the blank one.
    const worktreeId = 'wt-resume-status'
    expect(getStructuredAgentLaunchStatus(worktreeId, 'codex')).toBe('idle')

    startStructuredAgentLaunch(worktreeId, 'codex', {
      requestId: 'request-11',
      resumeFrom: { providerSessionId: 'thread-1' }
    })

    expect(getStructuredAgentLaunchStatus(worktreeId, 'codex')).toBe('pending')
    expect(getStructuredAgentLaunchStatus(worktreeId, 'claude')).toBe('idle')
  })
})
