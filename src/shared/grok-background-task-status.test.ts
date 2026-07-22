import { describe, expect, it } from 'vitest'
import { hasActiveGrokBackgroundTasks } from './grok-background-task-status'

describe('hasActiveGrokBackgroundTasks', () => {
  it('detects the active background-task status rendered by Grok', () => {
    expect(
      hasActiveGrokBackgroundTasks(
        ['Tasks 1', 'Task Background sleep 60 for Orca repro  33s', 'watching · 1 command'].join(
          '\n'
        ),
        true
      )
    ).toBe(true)
    expect(hasActiveGrokBackgroundTasks('Tasks 3\nwatching · 3 commands', true)).toBe(true)
  })

  it('uses the latest counts when retained output contains an older active state', () => {
    expect(
      hasActiveGrokBackgroundTasks(
        ['Tasks 1', 'watching · 1 command', 'Tasks 0', 'watching · 0 commands'].join('\n'),
        true
      )
    ).toBe(false)
  })

  it('ignores matching counters outside a recognized Grok session', () => {
    expect(hasActiveGrokBackgroundTasks('Tasks 1\nwatching · 1 command', false)).toBe(false)
  })

  it('requires both Grok status counters to avoid matching ordinary output', () => {
    expect(hasActiveGrokBackgroundTasks('Tasks 1\nready for input', true)).toBe(false)
    expect(hasActiveGrokBackgroundTasks('watching · 1 command', true)).toBe(false)
    expect(hasActiveGrokBackgroundTasks('Tasks 0\nwatching · 0 commands', true)).toBe(false)
  })
})
