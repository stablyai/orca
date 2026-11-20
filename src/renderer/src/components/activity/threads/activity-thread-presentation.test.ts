import { describe, expect, it } from 'vitest'
import { activityThreadRowIdentity } from './activity-thread-presentation'

function thread(repoName: string | null, worktree: { displayName: string; branch: string }) {
  return { repo: repoName ? { displayName: repoName } : null, worktree }
}

describe('activityThreadRowIdentity', () => {
  it('names only the project, never the workspace or branch beside it', () => {
    expect(
      activityThreadRowIdentity(
        thread('orca', { displayName: '', branch: 'feature/auth' }),
        'worktree'
      )
    ).toEqual({ showProject: true, showWorkspace: false })
    expect(
      activityThreadRowIdentity(
        thread('acme-app', { displayName: 'Checkout button', branch: 'acme_app' }),
        'status'
      )
    ).toEqual({ showProject: true, showWorkspace: false })
  })

  it('leaves the project to a project group header without falling back to the workspace', () => {
    expect(
      activityThreadRowIdentity(thread('acme', { displayName: 'acme', branch: '' }), 'project')
    ).toEqual({ showProject: false, showWorkspace: false })
  })

  it('names the workspace when the chat has no project record', () => {
    expect(
      activityThreadRowIdentity(thread(null, { displayName: '', branch: 'main' }), 'status')
    ).toEqual({ showProject: false, showWorkspace: true })
  })
})
