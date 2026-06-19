import { describe, expect, it } from 'vitest'
import { TASK_WORKTREE_CARD_PROPERTIES } from '../../../../shared/constants'
import {
  WORKTREE_CARD_PROPERTY_OPTIONS,
  getWorktreeCardPropertyOptions
} from './sidebar-workspace-option-items'

describe('worktree card property options', () => {
  it('keeps the combined Tasks option by default', () => {
    const options = getWorktreeCardPropertyOptions()

    expect(WORKTREE_CARD_PROPERTY_OPTIONS).toEqual(options)
    expect(options.map((option) => option.id)).toContain('tasks')
    expect(options.find((option) => option.id === 'tasks')?.properties).toEqual(
      TASK_WORKTREE_CARD_PROPERTIES
    )
    expect(options.map((option) => option.label)).toContain('Tasks')
    expect(options.map((option) => option.label)).not.toContain('GitHub issues')
    expect(options.map((option) => option.label)).not.toContain('Linear issues')
  })

  it('splits issue providers only when new card style is on', () => {
    const options = getWorktreeCardPropertyOptions({ newCardStyle: true })

    expect(options.map((option) => option.id)).not.toContain('tasks')
    expect(options.map((option) => option.id)).not.toContain('status')
    expect(options.find((option) => option.id === 'issue')?.properties).toEqual(['issue'])
    expect(options.find((option) => option.id === 'linear-issue')?.properties).toEqual([
      'linear-issue'
    ])
    expect(options.map((option) => option.label)).toContain('GitHub issues')
    expect(options.map((option) => option.label)).toContain('Linear issues')
  })
})
