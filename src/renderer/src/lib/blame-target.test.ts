import { describe, expect, it } from 'vitest'
import { resolveBlameTarget } from './blame-target'

type State = Parameters<typeof resolveBlameTarget>[0]

const FOLDER_WORKSPACE_ID = 'fw-1'
const FOLDER_KEY = `folder:${FOLDER_WORKSPACE_ID}`

function makeState(repoPaths: { path: string; connectionId?: string | null }[]): State {
  return {
    folderWorkspaces: [
      {
        id: FOLDER_WORKSPACE_ID,
        folderPath: '/work',
        projectGroupId: 'pg-1',
        connectionId: null
      }
    ],
    projectGroups: [{ id: 'pg-1', connectionId: null }],
    repos: repoPaths.map((repo, index) => ({
      id: `repo-${index}`,
      path: repo.path,
      projectGroupId: 'pg-1',
      connectionId: repo.connectionId ?? null
    })),
    worktreesByRepo: {
      'repo-wt': [{ id: 'wt-1', path: '/work/plain-worktree' }]
    }
  } as unknown as State
}

describe('resolveBlameTarget', () => {
  it('keeps the worktree root and tab-relative path for a normal worktree', () => {
    expect(
      resolveBlameTarget(makeState([]), 'wt-1', '/work/plain-worktree/src/index.ts', 'src/index.ts')
    ).toEqual({ rootPath: '/work/plain-worktree', relativePath: 'src/index.ts' })
  })

  it('blames a folder-workspace file against the child repo that owns it', () => {
    // Why: the workspace root is not a repo, so blaming it would ask the wrong
    // directory and the path would be workspace-relative rather than repo-relative.
    const state = makeState([{ path: '/work/api' }, { path: '/work/web' }])

    expect(
      resolveBlameTarget(state, FOLDER_KEY, '/work/web/src/app.tsx', 'web/src/app.tsx')
    ).toEqual({ rootPath: '/work/web', relativePath: 'src/app.tsx' })
  })

  it('prefers the deepest repo when repos are nested', () => {
    const state = makeState([{ path: '/work' }, { path: '/work/web' }])

    expect(
      resolveBlameTarget(state, FOLDER_KEY, '/work/web/src/app.tsx', 'web/src/app.tsx')
    ).toEqual({ rootPath: '/work/web', relativePath: 'src/app.tsx' })
  })

  it('returns null when no child repo contains the file', () => {
    const state = makeState([{ path: '/work/api' }])

    expect(resolveBlameTarget(state, FOLDER_KEY, '/work/notes/todo.md', 'notes/todo.md')).toBeNull()
  })

  it('returns null when two equally deep repos claim the file', () => {
    // Why: an ambiguous owner means an ambiguous host; showing no authorship
    // beats blaming against the wrong one.
    const state = makeState([
      { path: '/work/web', connectionId: null },
      { path: '/work/web', connectionId: 'ssh-1' }
    ])

    expect(
      resolveBlameTarget(state, FOLDER_KEY, '/work/web/src/app.tsx', 'web/src/app.tsx')
    ).toBeNull()
  })
})
