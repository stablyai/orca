import { describe, expect, it } from 'vitest'
import { getLinearIconTone } from './worktree-task-state'

describe('getLinearIconTone', () => {
  it('uses the merged-PR purple for completed issues', () => {
    expect(getLinearIconTone('Done', 'completed')).toContain('text-purple-')
  })

  it('uses red for canceled issues', () => {
    expect(getLinearIconTone('Canceled', 'canceled')).toContain('text-rose-')
  })

  it('stays grey for open and in-progress issues', () => {
    for (const [name, type] of [
      ['Todo', 'unstarted'],
      ['Backlog', 'backlog'],
      ['In Progress', 'started'],
      ['In Review', 'started']
    ]) {
      expect(getLinearIconTone(name, type)).toBe('text-muted-foreground')
    }
  })

  it('falls back to the state name when the type is missing', () => {
    expect(getLinearIconTone('Done')).toContain('text-purple-')
    expect(getLinearIconTone('Duplicate')).toContain('text-rose-')
  })

  it('stays grey while the issue state is not loaded', () => {
    expect(getLinearIconTone(undefined, undefined)).toBe('text-muted-foreground')
  })
})
