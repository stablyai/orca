import { describe, expect, it } from 'vitest'
import { withLocalTitles } from './cloud-workspace-local-titles'
import { cloudWorkspaceTitle } from './open-cloud-workspace'
import { workspace } from './cloud-workspaces.test-fixture'

describe('team list names a workspace, not its repo (RA-13)', () => {
  const untitled = workspace({
    id: 'sbx_1',
    workspaceId: 'orca-1',
    title: null,
    repo: { url: 'https://github.com/octocat/Hello-World.git', branch: null }
  })

  it('an untitled workspace this computer started reads by its name', () => {
    const [named] = withLocalTitles([untitled], new Map([['orca-1', 'ra12-asleep']]))
    expect(cloudWorkspaceTitle(named!)).toBe('ra12-asleep')
  })

  it("a teammate's untitled workspace still falls back to the repo", () => {
    const [other] = withLocalTitles([untitled], new Map())
    expect(cloudWorkspaceTitle(other!)).toBe('Hello-World')
  })

  it('a workspace with its own title keeps it', () => {
    const titled = { ...untitled, title: 'Fix login' }
    const [kept] = withLocalTitles([titled], new Map([['orca-1', 'ra12-asleep']]))
    expect(kept?.title).toBe('Fix login')
  })
})
