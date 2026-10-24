import { getDefaultSettings } from '../../../shared/constants'
import { TEST_REPO, makeWorktree } from '../store/slices/worktrees-slice-test-fixtures'
import { describe, expect, it, vi } from 'vitest'
import { buildAiVaultDropRepinStartup } from './ai-vault-resume-command'

vi.mock('@/lib/new-workspace', () => ({
  CLIENT_PLATFORM: 'darwin'
}))

const RECORDED_HOME = '/tmp/orca/codex-accounts/aaaa/home'
const SELECTED_HOME = '/tmp/orca/codex-accounts/bbbb/home'

type DropRepinState = Parameters<typeof buildAiVaultDropRepinStartup>[0]['state']

function makeState(): DropRepinState {
  return {
    activeRepoId: 'repo-1',
    activeWorktreeId: 'repo-1::worktree-1',
    folderWorkspaces: [],
    projectGroups: [],
    repos: [{ ...TEST_REPO, id: 'repo-1', path: '/Users/ada/repo' }],
    endpointProjectHostSetups: [],
    endpointProjects: [
      {
        id: 'repo-1',
        displayName: 'repo',
        badgeColor: '',
        createdAt: 0,
        updatedAt: 0,
        sourceRepoIds: ['repo-1']
      }
    ],
    settings: {
      ...getDefaultSettings('/tmp'),
      agentDefaultArgs: { claude: '', codex: '' },
      agentDefaultEnv: { claude: {}, codex: {} }
    },
    worktreesByRepo: {
      'repo-1': [
        makeWorktree({ id: 'repo-1::worktree-1', repoId: 'repo-1', path: '/Users/ada/repo' })
      ]
    }
  }
}

function payload(overrides: {
  sessionCwd?: string | null
  sessionFilePath?: string
}): Parameters<typeof buildAiVaultDropRepinStartup>[0]['payload'] {
  return {
    agent: 'codex',
    sessionId: 'session-1',
    sessionExecutionHostId: 'local',
    sessionFilePath: `${RECORDED_HOME}/sessions/2026/07/20/rollout-x.jsonl`,
    ...overrides
  }
}

describe('buildAiVaultDropRepinStartup', () => {
  it('repins a payload with a cwd to the substituted home', () => {
    const startup = buildAiVaultDropRepinStartup({
      state: makeState(),
      payload: payload({ sessionCwd: '/Users/ada/repo' }),
      substituteCodexHome: SELECTED_HOME,
      worktreeId: 'repo-1::worktree-1'
    })

    expect(startup).not.toBeNull()
    expect(startup?.command).toContain(`CODEX_HOME='${SELECTED_HOME}'`)
    expect(startup?.command).not.toContain(RECORDED_HOME)
    expect(startup).toMatchObject({ cwd: '/Users/ada/repo' })
  })

  it('repins a payload whose session has no cwd instead of keeping the wrong-account command', () => {
    const startup = buildAiVaultDropRepinStartup({
      state: makeState(),
      payload: payload({ sessionCwd: null }),
      substituteCodexHome: SELECTED_HOME,
      worktreeId: 'repo-1::worktree-1'
    })

    expect(startup).not.toBeNull()
    expect(startup?.command).toContain(`CODEX_HOME='${SELECTED_HOME}'`)
    expect(startup?.command).not.toContain(RECORDED_HOME)
    expect(startup?.command).not.toContain('cd ')
  })

  it('declines a payload from an older serializer that never carried sessionCwd', () => {
    const startup = buildAiVaultDropRepinStartup({
      state: makeState(),
      payload: payload({}),
      substituteCodexHome: SELECTED_HOME,
      worktreeId: 'repo-1::worktree-1'
    })

    expect(startup).toBeNull()
  })
})
