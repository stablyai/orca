import { describe, expect, it } from 'vitest'
import {
  createTaskPageGitHubStatusStateDraft,
  resolveTaskPageGitHubStatusStateDraft,
  updateTaskPageGitHubStatusLocalState
} from './task-page-github-status-state'

describe('TaskPage GitHub status state draft', () => {
  it('keeps optimistic local state while the backing item state is unchanged', () => {
    const item = { id: 'issue-1', state: 'open' as const }
    const current = updateTaskPageGitHubStatusLocalState(
      createTaskPageGitHubStatusStateDraft(item),
      item,
      'closed'
    )

    expect(resolveTaskPageGitHubStatusStateDraft(current, item)).toEqual({
      sourceItemId: 'issue-1',
      sourceState: 'open',
      localState: 'closed'
    })
  })

  it('reconciles to the backing state when the item state changes', () => {
    const current = updateTaskPageGitHubStatusLocalState(
      createTaskPageGitHubStatusStateDraft({ id: 'issue-1', state: 'open' }),
      { id: 'issue-1', state: 'open' },
      'closed'
    )

    expect(
      resolveTaskPageGitHubStatusStateDraft(current, { id: 'issue-1', state: 'closed' })
    ).toEqual({
      sourceItemId: 'issue-1',
      sourceState: 'closed',
      localState: 'closed'
    })
  })

  it('drops stale optimistic state when the table row switches items', () => {
    const current = updateTaskPageGitHubStatusLocalState(
      createTaskPageGitHubStatusStateDraft({ id: 'issue-1', state: 'open' }),
      { id: 'issue-1', state: 'open' },
      'closed'
    )

    expect(
      resolveTaskPageGitHubStatusStateDraft(current, { id: 'issue-2', state: 'open' })
    ).toEqual({
      sourceItemId: 'issue-2',
      sourceState: 'open',
      localState: 'open'
    })
  })
})
