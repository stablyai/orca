// @vitest-environment happy-dom

// Launch coalescing when a launch adopts a conversation. Drives the real intent builder, because
// the identity under test is derived there — mocking it out would assert only the mock's shape.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StructuredAgentSessionCreateParams } from '../../../shared/structured-agent-session-create'

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
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
    getState: () => ({ unifiedTabsByWorktree: {} }),
    subscribe: () => () => {}
  }
}))

import {
  getStructuredAgentLaunchStatus,
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

  it('does not hand a resume the blank launch already pending for the same worktree', async () => {
    // A joining caller is handed the EXISTING intent and contributes only its prompt, so joining
    // here would silently drop the adoption and open a blank chat instead.
    const worktreeId = 'wt-resume-vs-blank'
    const blank = startStructuredAgentLaunch(worktreeId, 'codex')
    const resume = startStructuredAgentLaunch(worktreeId, 'codex', {
      resumeFrom: { providerSessionId: 'thread-1' }
    })

    await flushLaunchDispatch()

    expect(resume.sessionId).not.toBe(blank.sessionId)
    expect(createParams()).toEqual([
      expect.not.objectContaining({ resumeFrom: expect.anything() }),
      expect.objectContaining({ resumeFrom: { providerSessionId: 'thread-1' } })
    ])
  })

  it('does not hand a blank launch the resume already pending for the same worktree', async () => {
    const worktreeId = 'wt-blank-vs-resume'
    const resume = startStructuredAgentLaunch(worktreeId, 'codex', {
      resumeFrom: { providerSessionId: 'thread-1' }
    })
    const blank = startStructuredAgentLaunch(worktreeId, 'codex')

    await flushLaunchDispatch()

    expect(blank.sessionId).not.toBe(resume.sessionId)
    expect(createParams()).toHaveLength(2)
  })

  it('keeps two resumes of different rows apart', async () => {
    const worktreeId = 'wt-two-rows'
    const first = startStructuredAgentLaunch(worktreeId, 'codex', {
      resumeFrom: { providerSessionId: 'thread-1' }
    })
    const second = startStructuredAgentLaunch(worktreeId, 'codex', {
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
    const first = startStructuredAgentLaunch(worktreeId, 'codex', { resumeFrom })
    const second = startStructuredAgentLaunch(worktreeId, 'codex', { resumeFrom })

    await flushLaunchDispatch()

    expect(second.sessionId).toBe(first.sessionId)
    expect(createParams()).toHaveLength(1)
  })

  it('keeps the same row apart across worktrees and agents', async () => {
    const resumeFrom = { providerSessionId: 'thread-1' }
    const here = startStructuredAgentLaunch('wt-here', 'codex', { resumeFrom })
    const there = startStructuredAgentLaunch('wt-there', 'codex', { resumeFrom })

    await flushLaunchDispatch()

    expect(there.sessionId).not.toBe(here.sessionId)
    expect(createParams()).toHaveLength(2)
  })

  it('reports a pending resume as a launch in flight for the worktree', () => {
    // "Is a chat starting here" means any launch for the pair, not only the blank one.
    const worktreeId = 'wt-resume-status'
    expect(getStructuredAgentLaunchStatus(worktreeId, 'codex')).toBe('idle')

    startStructuredAgentLaunch(worktreeId, 'codex', {
      resumeFrom: { providerSessionId: 'thread-1' }
    })

    expect(getStructuredAgentLaunchStatus(worktreeId, 'codex')).toBe('pending')
    expect(getStructuredAgentLaunchStatus(worktreeId, 'claude')).toBe('idle')
  })
})
