import { describe, expect, it, vi } from 'vitest'
import {
  askAgent,
  dispatchTaskToAgent,
  getActiveTerminalPaneKey,
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

describe('getActiveTerminalPaneKey', () => {
  it('returns pane key for the focused terminal leaf', () => {
    expect(
      getActiveTerminalPaneKey({
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
        activeTabType: 'browser',
        activeTabId: 'tab-1',
        terminalLayoutsByTabId: {
          'tab-1': { activeLeafId: LEAF_A }
        }
      })
    ).toBeNull()
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

  it('asks the worker and returns the answer', async () => {
    const callRuntime = vi.fn(
      async (request: { method: string; params?: Record<string, unknown> }) => {
        if (request.method === 'terminal.resolvePane') {
          const paneKey = String(request.params?.paneKey ?? '')
          return resolvePaneResponse(paneKey.startsWith('tab-coord') ? 'term_coord' : 'term_worker')
        }
        if (request.method === 'orchestration.ask') {
          return ok({ answer: 'use bcrypt', timedOut: false })
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
      answer: 'use bcrypt',
      timedOut: false,
      workerHandle: 'term_worker',
      coordinatorHandle: 'term_coord'
    })
  })
})
