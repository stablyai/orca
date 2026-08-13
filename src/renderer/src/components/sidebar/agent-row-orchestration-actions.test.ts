import { describe, expect, it, vi } from 'vitest'
import {
  askAgent,
  dispatchTaskToAgent,
  findActiveDispatchForWorker,
  formatCoordinatorWaitHint,
  getActiveTerminalPaneKey,
  listCoordinatorCandidates,
  resolveCoordinatorPaneKey,
  sendMessageToAgent
} from './agent-row-orchestration-actions'

const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'
const COORD_PANE = `tab-coord:${LEAF_A}`
const WORKER_PANE = `tab-worker:${LEAF_B}`

function ok(result: unknown) {
  return {
    id: 'req-1',
    ok: true as const,
    result,
    _meta: { runtimeId: 'runtime-1' }
  }
}

function resolvePaneResponse(handle: string) {
  return ok({
    terminal: {
      handle,
      tabId: 'tab',
      leafId: LEAF_A,
      ptyId: 'pty-1'
    }
  })
}

const emptyStateBase = {
  activeWorktreeId: 'wt-1' as string | null,
  tabsByWorktree: {} as Record<string, { id: string }[] | undefined>,
  agentStatusByPaneKey: {} as Record<string, unknown>
}

describe('getActiveTerminalPaneKey', () => {
  it('returns pane key for the focused terminal leaf', () => {
    expect(
      getActiveTerminalPaneKey({
        ...emptyStateBase,
        activeTabType: 'terminal',
        activeTabId: 'tab-1',
        terminalLayoutsByTabId: {
          'tab-1': { activeLeafId: LEAF_A }
        }
      })
    ).toBe(`tab-1:${LEAF_A}`)
  })

  it('returns null when no terminal is focused', () => {
    expect(
      getActiveTerminalPaneKey({
        ...emptyStateBase,
        activeTabType: 'browser',
        activeTabId: 'tab-1',
        terminalLayoutsByTabId: {
          'tab-1': { activeLeafId: LEAF_A }
        }
      })
    ).toBeNull()
  })
})

describe('resolveCoordinatorPaneKey', () => {
  it('prefers a focused terminal that is not the worker', () => {
    expect(
      resolveCoordinatorPaneKey({
        workerPaneKey: WORKER_PANE,
        workerWorktreeId: 'wt-1',
        state: {
          ...emptyStateBase,
          activeTabType: 'terminal',
          activeTabId: 'tab-coord',
          terminalLayoutsByTabId: {
            'tab-coord': { activeLeafId: LEAF_A },
            'tab-worker': { activeLeafId: LEAF_B }
          },
          tabsByWorktree: {
            'wt-1': [{ id: 'tab-coord' }, { id: 'tab-worker' }]
          }
        }
      })
    ).toBe(COORD_PANE)
  })

  it('falls back to another terminal in the worktree when focused is the worker', () => {
    expect(
      resolveCoordinatorPaneKey({
        workerPaneKey: WORKER_PANE,
        workerWorktreeId: 'wt-1',
        state: {
          ...emptyStateBase,
          activeTabType: 'terminal',
          activeTabId: 'tab-worker',
          terminalLayoutsByTabId: {
            'tab-coord': { activeLeafId: LEAF_A, root: { type: 'leaf', leafId: LEAF_A } },
            'tab-worker': { activeLeafId: LEAF_B, root: { type: 'leaf', leafId: LEAF_B } }
          },
          tabsByWorktree: {
            'wt-1': [{ id: 'tab-coord' }, { id: 'tab-worker' }]
          }
        }
      })
    ).toBe(COORD_PANE)
  })
})

describe('listCoordinatorCandidates', () => {
  it('excludes the worker and marks the focused terminal', () => {
    const candidates = listCoordinatorCandidates({
      workerPaneKey: WORKER_PANE,
      workerWorktreeId: 'wt-1',
      state: {
        ...emptyStateBase,
        activeTabType: 'terminal',
        activeTabId: 'tab-coord',
        terminalLayoutsByTabId: {
          'tab-coord': { activeLeafId: LEAF_A, root: { type: 'leaf', leafId: LEAF_A } },
          'tab-worker': { activeLeafId: LEAF_B, root: { type: 'leaf', leafId: LEAF_B } }
        },
        tabsByWorktree: {
          'wt-1': [{ id: 'tab-coord' }, { id: 'tab-worker' }]
        },
        agentStatusByPaneKey: {
          [COORD_PANE]: { prompt: 'I am the boss', agentType: 'claude' },
          [WORKER_PANE]: { prompt: 'I am the worker', agentType: 'codex' }
        }
      }
    })
    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.paneKey).toBe(COORD_PANE)
    expect(candidates[0]?.isFocused).toBe(true)
    expect(candidates[0]?.agentType).toBe('claude')
    expect(candidates[0]?.label).toContain('claude')
    expect(candidates[0]?.label).toContain('I am the boss')
    expect(candidates[0]?.label).toContain('(focused)')
  })
})

describe('dispatchTaskToAgent', () => {
  it('creates a task then dispatches with inject to the worker', async () => {
    const callRuntime = vi.fn(
      async (request: { method: string; params?: Record<string, unknown> }) => {
        if (request.method === 'terminal.resolvePane') {
          const paneKey = String(request.params?.paneKey ?? '')
          return resolvePaneResponse(paneKey.startsWith('tab-coord') ? 'term_coord' : 'term_worker')
        }
        if (request.method === 'orchestration.runCurrent') {
          return ok({ run: null })
        }
        if (request.method === 'orchestration.runCreate') {
          return ok({ run: { id: 'run_1', objective: 'Fix the login button' } })
        }
        if (request.method === 'orchestration.workerList') {
          return ok({ workers: [], counts: {} })
        }
        if (request.method === 'orchestration.taskList') {
          return ok({ tasks: [], count: 0 })
        }
        if (request.method === 'orchestration.taskCreate') {
          return ok({ task: { id: 'task_1', status: 'ready' } })
        }
        if (request.method === 'orchestration.dispatch') {
          return ok({ dispatch: { id: 'ctx_1' }, injected: true })
        }
        throw new Error(`unexpected ${request.method}`)
      }
    )

    await expect(
      dispatchTaskToAgent({
        workerPaneKey: WORKER_PANE,
        coordinatorPaneKey: COORD_PANE,
        spec: 'Fix the login button',
        callRuntime
      })
    ).resolves.toEqual({
      taskId: 'task_1',
      workerHandle: 'term_worker',
      coordinatorHandle: 'term_coord',
      injected: true
    })

    expect(callRuntime).toHaveBeenCalledWith({
      method: 'orchestration.runCreate',
      params: {
        objective: 'Fix the login button',
        from: 'term_coord'
      }
    })
    expect(callRuntime).toHaveBeenCalledWith({
      method: 'orchestration.taskCreate',
      params: {
        spec: 'Fix the login button',
        callerTerminalHandle: 'term_coord'
      }
    })
    expect(callRuntime).toHaveBeenCalledWith({
      method: 'orchestration.dispatch',
      params: {
        task: 'task_1',
        to: 'term_worker',
        from: 'term_coord',
        inject: true
      }
    })
    // Why: busy probe reuses the already-resolved worker handle — only one
    // resolvePane per pane (coord + worker), not a third for the taskList check.
    const resolvePaneCalls = callRuntime.mock.calls.filter(
      ([request]) => request.method === 'terminal.resolvePane'
    )
    expect(resolvePaneCalls).toHaveLength(2)
  })

  it('reuses the coordinator current Run instead of creating another', async () => {
    const callRuntime = vi.fn(
      async (request: { method: string; params?: Record<string, unknown> }) => {
        if (request.method === 'terminal.resolvePane') {
          const paneKey = String(request.params?.paneKey ?? '')
          return resolvePaneResponse(paneKey.startsWith('tab-coord') ? 'term_coord' : 'term_worker')
        }
        if (request.method === 'orchestration.runCurrent') {
          return ok({ run: { id: 'run_existing' } })
        }
        if (request.method === 'orchestration.workerList') {
          return ok({ workers: [], counts: {} })
        }
        if (request.method === 'orchestration.taskList') {
          return ok({ tasks: [], count: 0 })
        }
        if (request.method === 'orchestration.taskCreate') {
          return ok({ task: { id: 'task_1', status: 'ready' } })
        }
        if (request.method === 'orchestration.dispatch') {
          return ok({ dispatch: { id: 'ctx_1' }, injected: true })
        }
        throw new Error(`unexpected ${request.method}`)
      }
    )

    await dispatchTaskToAgent({
      workerPaneKey: WORKER_PANE,
      coordinatorPaneKey: COORD_PANE,
      spec: 'Fix the login button',
      callRuntime
    })

    expect(callRuntime).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'orchestration.runCreate' })
    )
    expect(callRuntime).toHaveBeenCalledWith({
      method: 'orchestration.taskList',
      params: { status: 'dispatched', callerTerminalHandle: 'term_coord' }
    })
  })

  it('rejects when the worker already has an active dispatch', async () => {
    const callRuntime = vi.fn(
      async (request: { method: string; params?: Record<string, unknown> }) => {
        if (request.method === 'terminal.resolvePane') {
          const paneKey = String(request.params?.paneKey ?? '')
          return resolvePaneResponse(paneKey.startsWith('tab-coord') ? 'term_coord' : 'term_worker')
        }
        if (request.method === 'orchestration.runCurrent') {
          return ok({ run: { id: 'run_busy' } })
        }
        if (request.method === 'orchestration.workerList') {
          return ok({
            workers: [
              {
                dispatchId: 'ctx_busy',
                taskId: 'task_busy',
                dispatchStatus: 'dispatched',
                agentTerminalHandle: 'term_worker'
              }
            ],
            counts: {}
          })
        }
        throw new Error(`unexpected ${request.method}`)
      }
    )

    await expect(
      dispatchTaskToAgent({
        workerPaneKey: WORKER_PANE,
        coordinatorPaneKey: COORD_PANE,
        spec: 'another job',
        callRuntime
      })
    ).rejects.toThrow(/already has an active dispatch/)
    expect(callRuntime).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'orchestration.taskCreate' })
    )
  })

  it('fails the created task when dispatch hits a cross-run assignee lock', async () => {
    const callRuntime = vi.fn(
      async (request: { method: string; params?: Record<string, unknown> }) => {
        if (request.method === 'terminal.resolvePane') {
          const paneKey = String(request.params?.paneKey ?? '')
          return resolvePaneResponse(paneKey.startsWith('tab-coord') ? 'term_coord' : 'term_worker')
        }
        if (request.method === 'orchestration.runCurrent') {
          return ok({ run: { id: 'run_new' } })
        }
        if (request.method === 'orchestration.workerList') {
          return ok({ workers: [], counts: {} })
        }
        if (request.method === 'orchestration.taskList') {
          return ok({ tasks: [], count: 0 })
        }
        if (request.method === 'orchestration.taskCreate') {
          return ok({ task: { id: 'task_orphan', status: 'ready' } })
        }
        if (request.method === 'orchestration.dispatch') {
          return {
            id: 'req-1',
            ok: false as const,
            error: {
              code: 'failed',
              message:
                'Terminal term_worker already has an active dispatch (ctx_other for task task_other)'
            },
            _meta: { runtimeId: 'runtime-1' }
          }
        }
        if (request.method === 'orchestration.taskUpdate') {
          return ok({ task: { id: 'task_orphan', status: 'failed' } })
        }
        throw new Error(`unexpected ${request.method}`)
      }
    )

    await expect(
      dispatchTaskToAgent({
        workerPaneKey: WORKER_PANE,
        coordinatorPaneKey: COORD_PANE,
        spec: 'another job',
        callRuntime
      })
    ).rejects.toThrow(/already has an active dispatch/)
    expect(callRuntime).toHaveBeenCalledWith({
      method: 'orchestration.taskUpdate',
      params: {
        id: 'task_orphan',
        status: 'failed',
        callerTerminalHandle: 'term_coord'
      }
    })
  })

  it('rejects when coordinator and worker are the same pane', async () => {
    const callRuntime = vi.fn()
    await expect(
      dispatchTaskToAgent({
        workerPaneKey: COORD_PANE,
        coordinatorPaneKey: COORD_PANE,
        spec: 'noop',
        callRuntime
      })
    ).rejects.toThrow(/same terminal/)
    expect(callRuntime).not.toHaveBeenCalled()
  })
})

describe('findActiveDispatchForWorker / wait hint', () => {
  it('returns the active dispatch for the worker handle', async () => {
    const callRuntime = vi.fn(
      async (request: { method: string; params?: Record<string, unknown> }) => {
        if (request.method === 'terminal.resolvePane') {
          return resolvePaneResponse('term_worker')
        }
        if (request.method === 'orchestration.workerList') {
          return ok({
            workers: [
              {
                dispatchId: 'ctx_9',
                taskId: 'task_9',
                dispatchStatus: 'dispatched',
                agentTerminalHandle: 'term_worker'
              }
            ],
            counts: {}
          })
        }
        throw new Error(`unexpected ${request.method}`)
      }
    )

    await expect(
      findActiveDispatchForWorker({
        workerPaneKey: WORKER_PANE,
        callRuntime
      })
    ).resolves.toEqual({
      workerHandle: 'term_worker',
      taskId: 'task_9',
      dispatchId: 'ctx_9'
    })
  })

  it('returns the coordinator wait hint used after dispatch', () => {
    expect(formatCoordinatorWaitHint()).toContain('orchestration check --wait')
    expect(formatCoordinatorWaitHint()).toContain('worker_done,escalation,question')
  })
})

describe('sendMessageToAgent / askAgent', () => {
  it('sends a status message from coordinator to worker', async () => {
    const callRuntime = vi.fn(
      async (request: { method: string; params?: Record<string, unknown> }) => {
        if (request.method === 'terminal.resolvePane') {
          const paneKey = String(request.params?.paneKey ?? '')
          return resolvePaneResponse(paneKey.startsWith('tab-coord') ? 'term_coord' : 'term_worker')
        }
        if (request.method === 'orchestration.send') {
          return ok({ message: { id: 'msg_1' } })
        }
        throw new Error(`unexpected ${request.method}`)
      }
    )

    await sendMessageToAgent({
      workerPaneKey: WORKER_PANE,
      coordinatorPaneKey: COORD_PANE,
      subject: 'Please review',
      body: 'Look at auth.ts',
      callRuntime
    })

    expect(callRuntime).toHaveBeenCalledWith({
      method: 'orchestration.send',
      params: {
        to: 'term_worker',
        from: 'term_coord',
        subject: 'Please review',
        body: 'Look at auth.ts',
        type: 'status'
      }
    })
  })

  it('sends a question message from coordinator to worker', async () => {
    const callRuntime = vi.fn(
      async (request: { method: string; params?: Record<string, unknown> }) => {
        if (request.method === 'terminal.resolvePane') {
          const paneKey = String(request.params?.paneKey ?? '')
          return resolvePaneResponse(paneKey.startsWith('tab-coord') ? 'term_coord' : 'term_worker')
        }
        if (request.method === 'orchestration.send') {
          return ok({ message: { id: 'msg_q1' } })
        }
        throw new Error(`unexpected ${request.method}`)
      }
    )

    await expect(
      askAgent({
        workerPaneKey: WORKER_PANE,
        coordinatorPaneKey: COORD_PANE,
        question: 'Which hash?',
        callRuntime
      })
    ).resolves.toMatchObject({
      workerHandle: 'term_worker',
      coordinatorHandle: 'term_coord'
    })

    expect(callRuntime).toHaveBeenCalledWith({
      method: 'orchestration.send',
      params: {
        to: 'term_worker',
        from: 'term_coord',
        subject: 'Which hash?',
        type: 'question'
      }
    })
  })
})
