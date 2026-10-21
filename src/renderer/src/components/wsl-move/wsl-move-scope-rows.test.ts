import { describe, expect, it } from 'vitest'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { Repo } from '../../../../shared/repo-types'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  findWslHostForDistro,
  wslMoveBlockerProjects,
  wslMoveCatalogCandidates,
  wslMoveCounts,
  wslMoveDistroOfPath,
  wslMoveProjectRows,
  wslMoveTargetForRepo,
  type WslMoveCatalog
} from './wsl-move-scope-rows'

const UNC = '\\\\wsl.localhost\\Ubuntu\\home\\dev\\api'
const LEAF = '11111111-2222-4333-8444-555555555555'

function repo(id: string, path: string, extra: Partial<Repo> = {}): Repo {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these tests read only id, path, displayName and the host fields.
  return { id, path, displayName: `Repo ${id}`, ...extra } as Repo
}

function folder(
  id: string,
  folderPath: string,
  extra: Partial<FolderWorkspace> = {}
): FolderWorkspace {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these tests read only id, name, folderPath and the host fields.
  return { id, name: `Folder ${id}`, folderPath, ...extra } as FolderWorkspace
}

function worktree(id: string, hostId?: string): Worktree {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: counts read only id and hostId.
  return { id, hostId } as Worktree
}

function wslHost(distro: string): PublicKnownRuntimeEnvironment {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the lookup reads only name and orcadDeployment.
  return {
    id: `wsl:${distro.toLowerCase()}`,
    name: `${distro} (WSL)`,
    orcadDeployment: { kind: 'wsl', distro, localPort: 1, remotePort: 2 }
  } as PublicKnownRuntimeEnvironment
}

describe('wslMoveDistroOfPath', () => {
  it('names the distro of a WSL folder, in either share spelling', () => {
    expect(wslMoveDistroOfPath(UNC)).toBe('Ubuntu')
    expect(wslMoveDistroOfPath('//wsl$/Debian/home/x')).toBe('Debian')
  })

  it('keeps Windows-drive folders and plain Windows paths on this computer', () => {
    expect(wslMoveDistroOfPath('\\\\wsl.localhost\\Ubuntu\\mnt\\c\\src\\api')).toBeNull()
    expect(wslMoveDistroOfPath('C:\\src\\api')).toBeNull()
  })
})

describe('wslMoveTargetForRepo', () => {
  it('offers the host, spelled as the host names its distro', () => {
    expect(
      wslMoveTargetForRepo(repo('r', UNC.replace('Ubuntu', 'ubuntu')), [wslHost('Ubuntu')])
    ).toBe('Ubuntu')
  })

  it('offers nothing without a host, for a Windows drive, or for a repo on another host', () => {
    expect(wslMoveTargetForRepo(repo('r', UNC), [])).toBeNull()
    expect(wslMoveTargetForRepo(repo('r', UNC), [wslHost('Debian')])).toBeNull()
    expect(
      wslMoveTargetForRepo(repo('r', '\\\\wsl.localhost\\Ubuntu\\mnt\\d\\x'), [wslHost('Ubuntu')])
    ).toBeNull()
    expect(
      wslMoveTargetForRepo(repo('r', UNC, { connectionId: 'ssh-1' }), [wslHost('Ubuntu')])
    ).toBeNull()
  })

  it('ignores non-WSL environments', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a runtime without a deployment link.
    const plain = { id: 'r1', name: 'Ubuntu' } as PublicKnownRuntimeEnvironment
    expect(findWslHostForDistro([plain], 'Ubuntu')).toBeNull()
  })
})

describe('rows, counts and blockers', () => {
  const api = `api::${UNC}`
  const catalog: WslMoveCatalog = {
    repos: [
      repo('api', UNC),
      // Same id on another host: never the name or the count of the local project.
      repo('api', '/home/dev/api', {
        displayName: 'Host copy',
        executionHostId: 'runtime:wsl:Ubuntu'
      })
    ],
    folderWorkspaces: [folder('notes', '\\\\wsl.localhost\\Ubuntu\\home\\dev\\notes')],
    worktreesByRepo: {
      api: [
        worktree(api, 'local'),
        worktree(`api::${UNC}\\feature`),
        worktree('api::/x', 'runtime:wsl:Ubuntu')
      ]
    },
    unifiedTabsByWorktree: {
      [api]: [
        { id: 't1', entityId: 'term-1', contentType: 'terminal' },
        { id: 'agent-session:s', entityId: 's', contentType: 'agent-session' },
        { id: '/a.ts', entityId: '/a.ts', contentType: 'editor' }
      ],
      'folder:notes': [{ id: 't2', entityId: 'term-2', contentType: 'terminal' }]
    }
  }

  it('names local rows and falls back to the id', () => {
    expect(wslMoveProjectRows(catalog, ['api', 'gone'], ['notes'])).toEqual([
      { kind: 'repo', id: 'api', name: 'Repo api' },
      { kind: 'repo', id: 'gone', name: 'gone' },
      { kind: 'folder', id: 'notes', name: 'Folder notes' }
    ])
  })

  it('counts local workspaces, terminals and chats of the selection', () => {
    expect(
      wslMoveCounts(catalog, [
        { kind: 'repo', id: 'api' },
        { kind: 'folder', id: 'notes' }
      ])
    ).toEqual({ projects: 2, workspaces: 3, terminals: 2, chats: 1 })
  })

  it('maps a pane blocker to the selected project that holds it, and ignores run ids', () => {
    const selected = [
      { kind: 'repo' as const, id: 'api' },
      { kind: 'folder' as const, id: 'notes' }
    ]
    expect(
      wslMoveBlockerProjects(
        catalog,
        {
          kind: 'process-running',
          ids: [`term-1:${LEAF}`, `term-2:${LEAF}`, 'run-7'],
          actions: ['end', 'skip-project']
        },
        selected
      )
    ).toEqual(selected)
    expect(
      wslMoveBlockerProjects(
        catalog,
        { kind: 'automation-running', ids: ['run-7'], actions: ['wait', 'skip-project'] },
        selected
      )
    ).toEqual([])
  })

  it('lists the distro catalog as the fallback candidates', () => {
    expect(
      wslMoveCatalogCandidates(
        {
          repos: [...catalog.repos, repo('win', 'C:\\src\\win'), repo('deb', '//wsl$/Debian/x')],
          folderWorkspaces: [
            ...catalog.folderWorkspaces,
            folder('remote', '\\\\wsl.localhost\\Ubuntu\\r', { connectionId: 'ssh-1' })
          ]
        },
        'ubuntu'
      )
    ).toEqual({ repoIds: ['api'], folderWorkspaceIds: ['notes'] })
  })
})
