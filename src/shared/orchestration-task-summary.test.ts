import { describe, expect, it } from 'vitest'
import { abbreviateOrchestrationTasks } from './orchestration-task-summary'

describe('abbreviateOrchestrationTasks', () => {
  it('collapses whitespace and caps long task specs', () => {
    const [task] = abbreviateOrchestrationTasks([
      { id: 'task_1', spec: `First line\n\n${'detail '.repeat(40)}` }
    ])

    expect(task.id).toBe('task_1')
    expect(task.spec).not.toContain('\n')
    expect(task.spec).toHaveLength(160)
    expect(task.spec.endsWith('…')).toBe(true)
    expect(task.spec_truncated).toBe(true)
  })

  it('preserves a short one-line spec', () => {
    const [task] = abbreviateOrchestrationTasks([{ spec: 'Short task' }])

    expect(task).toEqual({ spec: 'Short task', spec_truncated: false, result_truncated: false })
  })

  it('does not report whitespace normalization as truncation', () => {
    const [task] = abbreviateOrchestrationTasks([{ spec: 'Short\n\n  task' }])

    expect(task).toEqual({ spec: 'Short task', spec_truncated: false, result_truncated: false })
  })

  it('does not split a surrogate pair at the truncation boundary', () => {
    // 158 chars + an astral emoji spanning UTF-16 units 158-159: a naive
    // slice(0, 159) would cut the pair and leave a lone high surrogate.
    const [task] = abbreviateOrchestrationTasks([{ spec: `${'a'.repeat(158)}😀${'b'.repeat(40)}` }])

    expect(task.spec_truncated).toBe(true)
    expect(task.spec.isWellFormed()).toBe(true)
    expect(task.spec.endsWith('…')).toBe(true)
  })
})

describe('abbreviateOrchestrationTasks result field', () => {
  it('caps a long completed-task result and flags it', () => {
    const [task] = abbreviateOrchestrationTasks([
      { spec: 'Short task', result: `Report\n\n${'0123456789'.repeat(1000)}` }
    ])

    expect(task.result).toHaveLength(160)
    expect(task.result).not.toContain('\n')
    expect(task.result?.endsWith('…')).toBe(true)
    expect(task.result_truncated).toBe(true)
    expect(task.spec_truncated).toBe(false)
  })

  it('keeps a null result and a short result untruncated', () => {
    const [pending, done] = abbreviateOrchestrationTasks([
      { spec: 'Pending task', result: null },
      { spec: 'Done task', result: '{"ok": true}' }
    ])

    expect(pending).toEqual({
      spec: 'Pending task',
      spec_truncated: false,
      result: null,
      result_truncated: false
    })
    expect(done.result).toBe('{"ok": true}')
    expect(done.result_truncated).toBe(false)
  })

  it('does not split a surrogate pair at the result truncation boundary', () => {
    const [task] = abbreviateOrchestrationTasks([
      { spec: 'Short task', result: `${'a'.repeat(158)}😀${'b'.repeat(40)}` }
    ])

    expect(task.result_truncated).toBe(true)
    expect(task.result?.isWellFormed()).toBe(true)
    expect(task.result?.endsWith('…')).toBe(true)
  })

  it('leaves fields a runtime already abbreviated untouched', () => {
    // Why: a server-capped spec fits the cap, so re-abbreviating it would
    // flip spec_truncated back to false.
    const [task] = abbreviateOrchestrationTasks([
      { spec: 'already brief…', spec_truncated: true, result: 'r'.repeat(400) }
    ])

    expect(task.spec).toBe('already brief…')
    expect(task.spec_truncated).toBe(true)
    expect(task.result).toHaveLength(160)
    expect(task.result_truncated).toBe(true)
  })
})
