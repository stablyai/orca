import { describe, expect, it } from 'vitest'
import {
  activeDispatchFromTarget,
  agentRowOrchestrationDataProps,
  readAgentRowOrchestrationTarget
} from './worktree-agent-orchestration-menu'

describe('worktree-agent-orchestration-menu', () => {
  it('serializes agent row orchestration data attributes', () => {
    expect(
      agentRowOrchestrationDataProps({
        paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
        worktreeId: 'wt_1',
        coordinatorHandle: 'term_coord',
        dispatchId: 'ctx_1',
        taskId: 'task_1',
        dispatchStatus: 'dispatched'
      })
    ).toEqual({
      'data-agent-row-orchestration': '',
      'data-pane-key': 'tab-1:11111111-1111-4111-8111-111111111111',
      'data-worktree-id': 'wt_1',
      'data-coordinator-handle': 'term_coord',
      'data-dispatch-id': 'ctx_1',
      'data-task-id': 'task_1',
      'data-dispatch-status': 'dispatched'
    })
  })

  it('reads the agent target from a nested event target', () => {
    const row = {
      getAttribute: (name: string) => {
        if (name === 'data-pane-key') {
          return 'tab-1:11111111-1111-4111-8111-111111111111'
        }
        if (name === 'data-worktree-id') {
          return 'wt_1'
        }
        if (name === 'data-coordinator-handle') {
          return 'term_coord'
        }
        if (name === 'data-dispatch-id') {
          return 'ctx_1'
        }
        if (name === 'data-task-id') {
          return 'task_1'
        }
        if (name === 'data-dispatch-status') {
          return 'dispatched'
        }
        return null
      },
      hasAttribute: (name: string) => name === 'data-agent-row-orchestration'
    } as unknown as Element
    const target = {
      closest: (selector: string) => (selector === '[data-agent-row-orchestration]' ? row : null)
    } as unknown as EventTarget

    expect(readAgentRowOrchestrationTarget(target)).toEqual({
      paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
      worktreeId: 'wt_1',
      coordinatorHandle: 'term_coord',
      dispatchId: 'ctx_1',
      taskId: 'task_1',
      dispatchStatus: 'dispatched'
    })
    expect(activeDispatchFromTarget(readAgentRowOrchestrationTarget(target)!)).toEqual({
      taskId: 'task_1',
      dispatchId: 'ctx_1'
    })
  })

  it('reads the agent target from the event composed path', () => {
    // Why: Element instances are required by instanceof; use a real DOM node when available.
    if (typeof document === 'undefined') {
      return
    }
    const el = document.createElement('div')
    el.setAttribute('data-agent-row-orchestration', '')
    el.setAttribute('data-pane-key', 'tab-1:11111111-1111-4111-8111-111111111111')
    el.setAttribute('data-worktree-id', 'wt_1')
    const pathEvent = { composedPath: () => [el] } as unknown as Event
    expect(readAgentRowOrchestrationTarget(null, pathEvent)).toEqual({
      paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
      worktreeId: 'wt_1',
      coordinatorHandle: null,
      dispatchId: null,
      taskId: null,
      dispatchStatus: null
    })
  })

  it('returns null when the event is not on an agent row', () => {
    const target = {
      closest: () => null
    } as unknown as EventTarget
    expect(readAgentRowOrchestrationTarget(target)).toBeNull()
  })
})
