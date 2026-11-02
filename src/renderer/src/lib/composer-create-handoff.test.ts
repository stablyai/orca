import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'

const flow = vi.hoisted(() => ({
  begin: vi.fn(() => 'staged-1'),
  continue: vi.fn(() => true),
  run: vi.fn(() => 'run-1')
}))
const store = vi.hoisted(() => {
  const pendingWorktreeCreations: Record<string, { creationId: string; request: unknown }> = {}
  return {
    pendingWorktreeCreations,
    removePendingWorktreeCreation: vi.fn(),
    setActivePendingWorktreeCreation: vi.fn(),
    setActiveView: vi.fn(),
    setSidebarOpen: vi.fn()
  }
})
const toastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { error: toastError } }))
vi.mock('@/lib/worktree-creation-flow', () => ({
  beginBackgroundWorktreePreparation: flow.begin,
  continueBackgroundWorktreeCreation: flow.continue,
  runBackgroundWorktreeCreation: flow.run
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))

import {
  COMPOSER_CREATE_PREPARE_DEADLINE_MS,
  scheduleComposerCreateHandoff
} from './composer-create-handoff'

function makeRequest(name: string, linkedPR?: number): WorktreeCreationRequest {
  return {
    repoId: 'repo-1',
    name,
    ...(linkedPR != null ? { linkedPR } : {}),
    setupDecision: 'inherit',
    agent: null,
    pendingFirstAgentMessageRename: false,
    note: '',
    startupPlan: null,
    quickPrompt: '',
    quickTelemetry: null
  }
}
const stagingRequest = makeRequest('staged')
const finalRequest = makeRequest('final')

function schedule(isCancelled: () => boolean = () => false) {
  const onHandOff = vi.fn()
  const reopenComposer = vi.fn()
  const handoff = scheduleComposerCreateHandoff({
    stagingRequest,
    onHandOff,
    reopenComposer,
    isCancelled
  })
  return { handoff, onHandOff, reopenComposer }
}

function handOff(): ReturnType<typeof schedule> {
  const scheduled = schedule()
  vi.advanceTimersToNextTimer()
  store.pendingWorktreeCreations['staged-1'] = { creationId: 'staged-1', request: stagingRequest }
  return scheduled
}

describe('scheduleComposerCreateHandoff', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    for (const id of Object.keys(store.pendingWorktreeCreations)) {
      delete store.pendingWorktreeCreations[id]
    }
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('starts directly without staging or closing when preflight is fast', () => {
    const { handoff, onHandOff } = schedule()
    handoff.start(finalRequest)
    vi.runAllTimers()

    expect(flow.run).toHaveBeenCalledWith(finalRequest)
    expect(flow.begin).not.toHaveBeenCalled()
    expect(onHandOff).not.toHaveBeenCalled()
    expect(handoff.fail('boom')).toBe(false)
  })

  it('closes the composer onto a staged row when preflight stalls, then continues it', () => {
    const { handoff, onHandOff } = handOff()

    expect(flow.begin).toHaveBeenCalledWith(stagingRequest)
    expect(onHandOff).toHaveBeenCalledTimes(1)

    handoff.start(finalRequest)
    handoff.dispose()
    expect(flow.continue).toHaveBeenCalledWith('staged-1', finalRequest)
    expect(toastError).not.toHaveBeenCalled()
  })

  it('focuses an existing creation for the same PR instead of duplicating it', () => {
    store.pendingWorktreeCreations['other'] = {
      creationId: 'other',
      request: makeRequest('other', 42)
    }
    const { handoff } = handOff()
    handoff.start(makeRequest('final', 42))

    expect(flow.continue).not.toHaveBeenCalled()
    expect(store.removePendingWorktreeCreation).toHaveBeenCalledWith('staged-1')
    expect(store.setActivePendingWorktreeCreation).toHaveBeenCalledWith('other')
  })

  it('reports a handed-off failure once with a way back to the composer', () => {
    const { handoff, reopenComposer } = handOff()

    expect(handoff.fail('boom')).toBe(true)
    handoff.dispose()
    expect(store.removePendingWorktreeCreation).toHaveBeenCalledWith('staged-1')
    expect(toastError).toHaveBeenCalledTimes(1)
    toastError.mock.calls[0][1].action.onClick()
    expect(reopenComposer).toHaveBeenCalled()
  })

  it('drops a staged row that never starts by the deadline and ignores the late request', () => {
    const { handoff } = handOff()
    vi.advanceTimersByTime(COMPOSER_CREATE_PREPARE_DEADLINE_MS)
    delete store.pendingWorktreeCreations['staged-1']
    handoff.start(finalRequest)

    expect(toastError).toHaveBeenCalledTimes(1)
    expect(flow.continue).not.toHaveBeenCalled()
    expect(flow.run).not.toHaveBeenCalled()
  })

  it('stays quiet when the user cancelled the staged row', () => {
    const { handoff } = handOff()
    delete store.pendingWorktreeCreations['staged-1']
    handoff.start(finalRequest)
    handoff.dispose()

    expect(flow.continue).not.toHaveBeenCalled()
    expect(toastError).not.toHaveBeenCalled()
  })

  it('does not stage or close again after the user dismissed the composer', () => {
    const { onHandOff } = schedule(() => true)
    vi.runAllTimers()

    expect(flow.begin).not.toHaveBeenCalled()
    expect(onHandOff).not.toHaveBeenCalled()
  })
})
