import { describe, expect, it } from 'vitest'
import { activityThreadRowIdentity } from './activity-thread-presentation'
import type { AgentPaneThread } from './activity-thread-types'

function thread(
  repoName: string | null,
  worktree: { displayName: string; branch: string }
): Pick<AgentPaneThread, 'repo' | 'worktree'> {
  return {
    repo: repoName ? ({ displayName: repoName } as AgentPaneThread['repo']) : null,
    worktree: worktree as AgentPaneThread['worktree']
  }
}

describe('activityThreadRowIdentity', () => {
  it('keeps the branch when a workspace group header has no name to show', () => {
    expect(
      activityThreadRowIdentity(
        thread('orca', { displayName: '', branch: 'feature/auth' }),
        'worktree'
      )
    ).toEqual({ showProject: true, showWorkspace: true })
  })

  it('drops a workspace name that only repeats the project', () => {
    expect(
      activityThreadRowIdentity(thread('acme', { displayName: 'acme', branch: '' }), 'status')
    ).toEqual({ showProject: true, showWorkspace: false })
  })
})
