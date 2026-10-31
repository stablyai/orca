import { describe, expect, it } from 'vitest'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { projectHostSetupProjectionFromRepos } from '../../../shared/project-host-setup-projection'
import type { ProjectHostSetup } from '../../../shared/project-types'
import type { Repo } from '../../../shared/repo-types'
import type { TerminalQuickCommand } from '../../../shared/terminal-quick-command-types'
import { terminalQuickCommandMatchesWorkspaceProject } from './terminal-quick-command-project-scope'

type ScopeSetup = Pick<ProjectHostSetup, 'hostId' | 'projectId' | 'repoId'>

const LOCAL_REPO_ID = '32a0226d-9f33-42e8-8b7b-24867dea06d4'
const WINDOWS_REPO_ID = 'a0a2b4a4-1bff-494c-b005-d77918abc6a7'

function command(repoId: string): TerminalQuickCommand {
  return {
    id: 'test-orca',
    label: 'Test Orca',
    action: 'terminal-command',
    command: 'pnpm test',
    appendEnter: true,
    scope: { type: 'repo', repoId }
  }
}

function setup(
  hostId: ExecutionHostId,
  repoId: string,
  projectId = 'github:stablyai/orca'
): ScopeSetup {
  return { hostId, projectId, repoId }
}

describe('terminalQuickCommandMatchesWorkspaceProject', () => {
  it.each<ExecutionHostId>(['runtime:windows-2', 'ssh:windows-2'])(
    'shows a local repo command in the same project on %s',
    (targetHostId) => {
      const projectHostSetups = [
        setup('local', LOCAL_REPO_ID),
        setup(targetHostId, WINDOWS_REPO_ID)
      ]

      expect(
        terminalQuickCommandMatchesWorkspaceProject(command(LOCAL_REPO_ID), {
          commandHostId: 'local',
          projectHostSetups,
          targetHostId,
          targetRepoId: WINDOWS_REPO_ID
        })
      ).toBe(true)
    }
  )

  it('matches the user topology from host-fetched repo catalogs', () => {
    const repo = (id: string, path: string, executionHostId?: ExecutionHostId): Repo => ({
      id,
      path,
      displayName: 'orca',
      badgeColor: '#737373',
      addedAt: 100,
      kind: 'git',
      gitRemoteIdentity: {
        canonicalKey: 'github.com/stablyai/orca',
        remoteName: 'origin',
        remoteUrl: 'git@github.com:stablyai/orca.git'
      },
      ...(executionHostId ? { executionHostId } : {})
    })
    const projectHostSetups = projectHostSetupProjectionFromRepos([
      repo(LOCAL_REPO_ID, '/Users/alice/orca'),
      repo(WINDOWS_REPO_ID, 'C:\\Users\\alice\\orca', 'runtime:windows-2')
    ]).setups

    expect(
      terminalQuickCommandMatchesWorkspaceProject(command(LOCAL_REPO_ID), {
        commandHostId: 'local',
        projectHostSetups,
        targetHostId: 'runtime:windows-2',
        targetRepoId: WINDOWS_REPO_ID
      })
    ).toBe(true)
  })

  it('does not show a repo command for a different known project', () => {
    const projectHostSetups = [
      setup('local', LOCAL_REPO_ID),
      setup('runtime:windows-2', WINDOWS_REPO_ID, 'github:stablyai/other')
    ]

    expect(
      terminalQuickCommandMatchesWorkspaceProject(command(LOCAL_REPO_ID), {
        commandHostId: 'local',
        projectHostSetups,
        targetHostId: 'runtime:windows-2',
        targetRepoId: WINDOWS_REPO_ID
      })
    ).toBe(false)
  })

  it('does not trust colliding cross-host repo ids when both projects are known', () => {
    const projectHostSetups = [
      setup('local', LOCAL_REPO_ID),
      setup('runtime:windows-2', LOCAL_REPO_ID, 'github:stablyai/other')
    ]

    expect(
      terminalQuickCommandMatchesWorkspaceProject(command(LOCAL_REPO_ID), {
        commandHostId: 'local',
        projectHostSetups,
        targetHostId: 'runtime:windows-2',
        targetRepoId: LOCAL_REPO_ID
      })
    ).toBe(false)
  })

  it('does not infer a missing target setup from another host repo id', () => {
    const projectHostSetups = [setup('local', LOCAL_REPO_ID), setup('ssh:builder', WINDOWS_REPO_ID)]

    expect(
      terminalQuickCommandMatchesWorkspaceProject(command(LOCAL_REPO_ID), {
        commandHostId: 'local',
        projectHostSetups,
        targetHostId: 'runtime:windows-2',
        targetRepoId: WINDOWS_REPO_ID
      })
    ).toBe(false)
  })

  it('preserves exact repo-id matching when legacy project metadata is unavailable', () => {
    expect(
      terminalQuickCommandMatchesWorkspaceProject(command(LOCAL_REPO_ID), {
        commandHostId: 'local',
        projectHostSetups: [],
        targetHostId: 'runtime:legacy',
        targetRepoId: LOCAL_REPO_ID
      })
    ).toBe(true)
  })

  it('resolves a settings-owned command whose repo executes through SSH', () => {
    const projectHostSetups = [
      setup('ssh:builder', LOCAL_REPO_ID),
      setup('runtime:windows-2', WINDOWS_REPO_ID)
    ]

    expect(
      terminalQuickCommandMatchesWorkspaceProject(command(LOCAL_REPO_ID), {
        commandHostId: 'local',
        projectHostSetups,
        targetHostId: 'runtime:windows-2',
        targetRepoId: WINDOWS_REPO_ID
      })
    ).toBe(true)
  })

  it('keeps a remote-host repo command visible on its own repo', () => {
    expect(
      terminalQuickCommandMatchesWorkspaceProject(command(WINDOWS_REPO_ID), {
        commandHostId: 'runtime:windows-2',
        projectHostSetups: [],
        targetHostId: 'runtime:windows-2',
        targetRepoId: WINDOWS_REPO_ID
      })
    ).toBe(true)
  })

  it('keeps global commands visible without a repo and repo commands hidden', () => {
    const globalCommand: TerminalQuickCommand = {
      ...command(LOCAL_REPO_ID),
      scope: { type: 'global' }
    }
    const context = {
      commandHostId: 'local' as const,
      projectHostSetups: [],
      targetHostId: 'runtime:folder' as const,
      targetRepoId: null
    }

    expect(terminalQuickCommandMatchesWorkspaceProject(globalCommand, context)).toBe(true)
    expect(terminalQuickCommandMatchesWorkspaceProject(command(LOCAL_REPO_ID), context)).toBe(false)
  })
})
