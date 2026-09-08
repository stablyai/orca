import { describe, expect, it } from 'vitest'
import {
  buildInjectRejectionMessage,
  taskNotFoundRefusal,
  taskNotStartableRefusal
} from './orchestration-dispatch-refusal-contract'
import { TUI_AGENT_CONFIG } from './tui-agent-config'
import { recognizeAgentProcess } from './agent-process-recognition'

describe('buildInjectRejectionMessage', () => {
  const message = buildInjectRejectionMessage('term_a')

  it('keeps the substring callers and scripts match on', () => {
    expect(message).toContain('Cannot dispatch --inject to terminal term_a')
    expect(message).toContain('no recognized agent detected')
  })

  it('names every agent Orca recognizes, including agy', () => {
    expect(message).toMatch(/\bagy\b/)
    for (const config of Object.values(TUI_AGENT_CONFIG)) {
      expect(message).toContain(config.expectedProcess)
    }
  })

  it('lists only names detection actually resolves, deduped and sorted', () => {
    const listed = (/\(([^)]+)\)/.exec(message)?.[1] ?? '').split(', ')

    expect(listed.length).toBeGreaterThan(0)
    expect(new Set(listed).size).toBe(listed.length)
    expect([...listed].sort()).toEqual(listed)
    for (const name of listed) {
      expect(recognizeAgentProcess(name)).not.toBeNull()
    }
  })
})

// Why: these strings are published receipts; they are pinned as literals, independent of the
// builders, so a refactor cannot silently rewrite them together with the expectation.
describe('dispatch refusal receipts keep their published messages', () => {
  it('leaves the message exactly as each call site supplies it', () => {
    expect(taskNotFoundRefusal('Task not found: task_1', { taskId: 'task_1' }).message).toBe(
      'Task not found: task_1'
    )
    expect(
      taskNotStartableRefusal('Task task_1 is pending; only a ready Task can start.', {
        taskId: 'task_1',
        status: 'pending',
        unmetDependencies: []
      }).message
    ).toBe('Task task_1 is pending; only a ready Task can start.')
  })

  it('tailors nextSteps to retry, dependency, occupancy, and terminal-status refusals', () => {
    const base = { taskId: 'task_1', status: 'failed', unmetDependencies: [] }
    expect(taskNotStartableRefusal('m', { ...base, retryOf: 'ctx_1' }).data.nextSteps[0]).toMatch(
      /--retry-of.*ctx_1/
    )
    expect(
      taskNotStartableRefusal('m', { ...base, status: 'pending', unmetDependencies: ['task_0'] })
        .data.nextSteps[0]
    ).toMatch(/task_0.*unblock failed/)
    expect(
      taskNotStartableRefusal('m', { ...base, status: 'dispatched' }).data.nextSteps[0]
    ).toMatch(/dispatch-show --task task_1/)
    expect(taskNotStartableRefusal('m', base).data.nextSteps[0]).toMatch(/failed Task cannot/)
  })
})
