import { describe, expect, it } from 'vitest'
import { findRuntimeWorkspaceFileOwner } from './runtime-workspace-file-owner'

describe('findRuntimeWorkspaceFileOwner', () => {
  const roots = [
    { workspaceId: 'repo-a', rootPath: '/srv/repo-a', executionHostId: 'runtime:host-a' as const },
    { workspaceId: 'repo-b', rootPath: '/srv/repo-b', executionHostId: 'runtime:host-a' as const },
    {
      workspaceId: 'repo-b-docs',
      rootPath: '/srv/repo-b/docs',
      executionHostId: 'runtime:host-a' as const
    },
    {
      workspaceId: 'other-host',
      rootPath: '/srv/repo-b',
      executionHostId: 'runtime:host-b' as const
    }
  ]

  it('finds a sibling workspace on the same execution host', () => {
    expect(
      findRuntimeWorkspaceFileOwner(roots, '/srv/repo-b/src/index.ts', 'runtime:host-a')
    ).toMatchObject({
      workspaceId: 'repo-b',
      relativePath: 'src/index.ts'
    })
  })

  it('uses the most specific nested workspace root', () => {
    expect(
      findRuntimeWorkspaceFileOwner(roots, '/srv/repo-b/docs/guide.md', 'runtime:host-a')
    ).toMatchObject({
      workspaceId: 'repo-b-docs',
      relativePath: 'guide.md'
    })
  })

  it('uses an exact nested workspace root instead of its parent', () => {
    expect(
      findRuntimeWorkspaceFileOwner(roots, '/srv/repo-b/docs', 'runtime:host-a')
    ).toMatchObject({
      workspaceId: 'repo-b-docs',
      relativePath: ''
    })
  })

  it('does not cross execution-host boundaries', () => {
    expect(
      findRuntimeWorkspaceFileOwner(roots, '/srv/repo-b/src/index.ts', 'runtime:host-b')
    ).toMatchObject({
      workspaceId: 'other-host'
    })
    expect(findRuntimeWorkspaceFileOwner(roots, '/srv/repo-a/file.ts', 'runtime:host-b')).toBeNull()
  })

  it('matches Windows roots without case-sensitive drive assumptions', () => {
    expect(
      findRuntimeWorkspaceFileOwner(
        [
          {
            workspaceId: 'windows-repo',
            rootPath: 'C:\\Work\\Repo',
            executionHostId: 'runtime:windows'
          }
        ],
        'c:\\work\\repo\\src\\index.ts',
        'runtime:windows'
      )
    ).toMatchObject({
      workspaceId: 'windows-repo',
      relativePath: 'src/index.ts'
    })
  })
})
