// Host answers both the desktop sidebar's and the phone's Project grouping tests run on.
import type { MobileProjectSectionCatalog } from './mobile-project-sections-contract'
import type { ExecutionHostId } from './execution-host'
import {
  projectHostSetupProjectionFromRepos,
  type ProjectHostSetupProjection
} from './project-host-setup-projection'
import type { Repo } from './repo-types'
import type { RuntimeClientTarget } from './runtime-client-target'

const orcaRemote = {
  canonicalKey: 'github.com/stablyai/orca',
  remoteName: 'origin',
  remoteUrl: 'git@github.com:stablyai/orca.git'
}

function hostRepo(id: string, path: string, displayName = 'orca'): Repo {
  return {
    id,
    path,
    displayName,
    badgeColor: '#737373',
    addedAt: 1,
    ...(displayName === 'orca' ? { gitRemoteIdentity: orcaRemote } : {})
  }
}

export type ParityHostAnswer = {
  target: RuntimeClientTarget
  hostId: ExecutionHostId
  /** In the host's own repo.list order. */
  repos: Repo[]
  /** The host's project.list/projectHostSetup.list rows; null for a host that predates them. */
  lists: ProjectHostSetupProjection | null
}

const localRepos = [
  hostRepo('local-stably', '/Users/jinwoo/stably/orca'),
  hostRepo('local-assets', '/Users/jinwoo/design-assets', 'design-assets'),
  hostRepo('local-workspace', '/Users/jinwoo/orca/workspaces/orca/orca')
]
const windowsRepo = hostRepo('win-orca', 'C:/Users/jinwo/orca/orca')

// Several local checkouts plus copies of the same project on two servers.
export const PROJECT_SECTION_PARITY_HOSTS: readonly ParityHostAnswer[] = [
  {
    target: { kind: 'local' },
    hostId: 'local',
    repos: localRepos,
    lists: projectHostSetupProjectionFromRepos(localRepos)
  },
  {
    target: { kind: 'environment', environmentId: 'windows2' },
    hostId: 'runtime:windows2',
    repos: [windowsRepo],
    // A server's own catalog rows: its project name and an imported setup on its local host.
    lists: {
      projects: [
        {
          id: 'github:stablyai/orca',
          displayName: 'Orca',
          badgeColor: '#737373',
          providerIdentity: { provider: 'github', owner: 'stablyai', repo: 'orca' },
          sourceRepoIds: [windowsRepo.id],
          createdAt: 5,
          updatedAt: 5
        }
      ],
      setups: [
        {
          id: 'win-setup',
          projectId: 'github:stablyai/orca',
          hostId: 'local',
          repoId: windowsRepo.id,
          path: windowsRepo.path,
          displayName: 'orca',
          setupState: 'ready',
          setupMethod: 'imported-existing-folder',
          createdAt: 5,
          updatedAt: 5
        }
      ]
    }
  },
  {
    target: { kind: 'environment', environmentId: 'm4air' },
    hostId: 'runtime:m4air',
    repos: [
      hostRepo('m4-orca', '/Users/m4air/orca/orca'),
      hostRepo('m4-orca-two', '/Users/m4air/orca-two/orca')
    ],
    lists: null
  }
]

/** Workspace rows; activity order differs from catalog order, so Recent and Manual disagree. */
export const PROJECT_SECTION_PARITY_ROWS: readonly {
  id: string
  repoId: string
  lastActivityAt: number
}[] = [
  { id: 'wt-m4-two', repoId: 'm4-orca-two', lastActivityAt: 90 },
  { id: 'wt-win', repoId: 'win-orca', lastActivityAt: 70 },
  { id: 'wt-workspace', repoId: 'local-workspace', lastActivityAt: 50 },
  { id: 'wt-stably', repoId: 'local-stably', lastActivityAt: 30 },
  { id: 'wt-m4', repoId: 'm4-orca', lastActivityAt: 10 }
]

// Same-host checkouts still need path prefixes; other machines do not.
const STABLY = {
  key: 'project:github:stablyai/orca::setup:local-stably',
  label: 'stably/orca'
}
const WORKSPACE = {
  key: 'project:github:stablyai/orca::setup:local-workspace',
  label: 'orca/orca'
}
// Why 'orca', not the server's 'Orca': the later host's derived project name wins the merge.
const WINDOWS = { key: 'project:github:stablyai/orca', label: 'orca' }
const M4 = { key: 'project:github:stablyai/orca::setup:m4-orca', label: 'orca/orca' }
const M4_TWO = {
  key: 'project:github:stablyai/orca::setup:m4-orca-two',
  label: 'orca-two/orca'
}
const ASSETS = { key: 'project:repo:local-assets', label: 'design-assets' }

export const PROJECT_SECTION_PARITY_HEADERS = {
  recent: [M4_TWO, WINDOWS, WORKSPACE, STABLY, M4, ASSETS],
  manual: [STABLY, ASSETS, WORKSPACE, WINDOWS, M4, M4_TWO]
} as const

/** What main serves the phone for these answers (the renderer's published catalog). */
export const PROJECT_SECTION_PARITY_SERVED: MobileProjectSectionCatalog = {
  repos: [
    {
      id: 'local-stably',
      displayName: 'orca',
      path: '/Users/jinwoo/stably/orca',
      badgeColor: '#737373',
      addedAt: 1,
      executionHostId: 'local'
    },
    {
      id: 'local-assets',
      displayName: 'design-assets',
      path: '/Users/jinwoo/design-assets',
      badgeColor: '#737373',
      addedAt: 1,
      executionHostId: 'local'
    },
    {
      id: 'local-workspace',
      displayName: 'orca',
      path: '/Users/jinwoo/orca/workspaces/orca/orca',
      badgeColor: '#737373',
      addedAt: 1,
      executionHostId: 'local'
    },
    {
      id: 'win-orca',
      displayName: 'orca',
      path: 'C:/Users/jinwo/orca/orca',
      badgeColor: '#737373',
      addedAt: 1,
      executionHostId: 'runtime:windows2'
    },
    {
      id: 'm4-orca',
      displayName: 'orca',
      path: '/Users/m4air/orca/orca',
      badgeColor: '#737373',
      addedAt: 1,
      executionHostId: 'runtime:m4air'
    },
    {
      id: 'm4-orca-two',
      displayName: 'orca',
      path: '/Users/m4air/orca-two/orca',
      badgeColor: '#737373',
      addedAt: 1,
      executionHostId: 'runtime:m4air'
    }
  ],
  projects: [
    { id: 'repo:local-assets', displayName: 'design-assets' },
    { id: 'github:stablyai/orca', displayName: 'orca' }
  ],
  setups: [
    {
      id: 'local-stably',
      projectId: 'github:stablyai/orca',
      hostId: 'local',
      repoId: 'local-stably',
      path: '/Users/jinwoo/stably/orca',
      displayName: 'orca',
      setupMethod: 'legacy-repo'
    },
    {
      id: 'local-assets',
      projectId: 'repo:local-assets',
      hostId: 'local',
      repoId: 'local-assets',
      path: '/Users/jinwoo/design-assets',
      displayName: 'design-assets',
      setupMethod: 'legacy-repo'
    },
    {
      id: 'local-workspace',
      projectId: 'github:stablyai/orca',
      hostId: 'local',
      repoId: 'local-workspace',
      path: '/Users/jinwoo/orca/workspaces/orca/orca',
      displayName: 'orca',
      setupMethod: 'legacy-repo'
    },
    {
      id: 'win-setup',
      projectId: 'github:stablyai/orca',
      hostId: 'runtime:windows2',
      repoId: 'win-orca',
      path: 'C:/Users/jinwo/orca/orca',
      displayName: 'orca',
      setupMethod: 'imported-existing-folder',
      connectionId: null,
      executionHostId: 'runtime:windows2'
    },
    {
      id: 'm4-orca',
      projectId: 'github:stablyai/orca',
      hostId: 'runtime:m4air',
      repoId: 'm4-orca',
      path: '/Users/m4air/orca/orca',
      displayName: 'orca',
      setupMethod: 'legacy-repo',
      executionHostId: 'runtime:m4air'
    },
    {
      id: 'm4-orca-two',
      projectId: 'github:stablyai/orca',
      hostId: 'runtime:m4air',
      repoId: 'm4-orca-two',
      path: '/Users/m4air/orca-two/orca',
      displayName: 'orca',
      setupMethod: 'legacy-repo',
      executionHostId: 'runtime:m4air'
    }
  ],
  projectOrderBy: 'manual'
}
