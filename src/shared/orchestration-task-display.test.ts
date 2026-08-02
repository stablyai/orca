import { describe, expect, it } from 'vitest'
import {
  buildOrchestrationTaskDisplayMetadata,
  ORCHESTRATION_DISPLAY_NAME_MAX_LENGTH,
  ORCHESTRATION_TASK_TITLE_MAX_LENGTH
} from './orchestration-task-display'

describe('buildOrchestrationTaskDisplayMetadata', () => {
  it('uses explicit task title and display name when provided', () => {
    expect(
      buildOrchestrationTaskDisplayMetadata({
        spec: 'Long implementation details',
        taskTitle: 'Checkout race',
        displayName: 'Fix checkout race'
      })
    ).toEqual({
      taskTitle: 'Checkout race',
      displayName: 'Fix checkout race'
    })
  })

  it('derives a task title from the first non-empty spec line', () => {
    expect(
      buildOrchestrationTaskDisplayMetadata({
        spec: '\n\nFix login form\n\nAdd focused tests'
      })
    ).toEqual({
      taskTitle: 'Fix login form',
      displayName: 'Fix login form'
    })
  })

  it('normalizes and caps explicit task display fields', () => {
    const metadata = buildOrchestrationTaskDisplayMetadata({
      spec: 'fallback',
      taskTitle: `  ${'x'.repeat(120)}\n`,
      displayName: `  ${'y'.repeat(220)}\n`
    })

    expect(metadata.taskTitle).toHaveLength(ORCHESTRATION_TASK_TITLE_MAX_LENGTH)
    expect(metadata.taskTitle.endsWith('...')).toBe(true)
    expect(metadata.displayName).toHaveLength(ORCHESTRATION_DISPLAY_NAME_MAX_LENGTH)
    expect(metadata.displayName.endsWith('...')).toBe(true)
  })

  it('does not leave a dangling high surrogate when truncating', () => {
    const metadata = buildOrchestrationTaskDisplayMetadata({
      spec: `x${'😀'.repeat(ORCHESTRATION_TASK_TITLE_MAX_LENGTH)}`
    })
    const last = metadata.taskTitle.charCodeAt(metadata.taskTitle.length - 1)

    expect(metadata.taskTitle.length).toBeLessThanOrEqual(ORCHESTRATION_TASK_TITLE_MAX_LENGTH)
    expect(last < 0xd800 || last > 0xdbff).toBe(true)
  })
})
