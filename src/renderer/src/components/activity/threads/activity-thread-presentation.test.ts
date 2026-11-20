import { describe, expect, it } from 'vitest'
import { activityThreadRowIdentity } from './activity-thread-presentation'

function thread(repoName: string | null, worktree: { displayName: string; branch: string }) {
  return { repo: repoName ? { displayName: repoName } : null, worktree }
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
    expect(
      activityThreadRowIdentity(
        thread('acme-app', { displayName: '', branch: 'acme_app' }),
        'status'
      )
    ).toEqual({ showProject: true, showWorkspace: true })
  })
})
