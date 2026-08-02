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

    expect(task).toEqual({ spec: 'Short task', spec_truncated: false })
  })

  it('does not report whitespace normalization as truncation', () => {
    const [task] = abbreviateOrchestrationTasks([{ spec: 'Short\n\n  task' }])

    expect(task).toEqual({ spec: 'Short task', spec_truncated: false })
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
