import { describe, expect, it } from 'vitest'
import { buildOrchestrationTaskDisplayMetadata } from './orchestration-task-display'

describe('buildOrchestrationTaskDisplayMetadata', () => {
  it('derives a plain title from a Markdown spec', () => {
    const title = (spec: string) => buildOrchestrationTaskDisplayMetadata({ spec }).taskTitle
    expect(title('# Code review only: **check** the _parser_\n\nDetails')).toBe(
      'Code review only: check the parser'
    )
    expect(title('\n## \n> Fix `__init__` in [the loader](https://x.test/a_b_c)')).toBe(
      'Fix __init__ in the loader'
    )
    expect(
      buildOrchestrationTaskDisplayMetadata({ spec: '# x', taskTitle: '# Kept' }).taskTitle
    ).toBe('# Kept')
  })
})
