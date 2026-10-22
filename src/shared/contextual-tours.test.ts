import { describe, expect, it } from 'vitest'
import { normalizeContextualTourIds } from './contextual-tours'

describe('contextual tour ids', () => {
  it('normalizes persisted ids by removing unknowns and duplicates', () => {
    expect(
      normalizeContextualTourIds([
        'tasks',
        'unknown',
        'workspace-agent-sessions',
        'browser',
        'tasks',
        null,
        'workspace-creation'
      ])
    ).toEqual(['tasks', 'workspace-agent-sessions', 'browser', 'workspace-creation'])
  })
})
