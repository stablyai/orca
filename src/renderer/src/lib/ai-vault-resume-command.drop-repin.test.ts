import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import {
  buildAiVaultDropLaunchStartup,
  buildAiVaultDropRepinStartup,
  buildAiVaultDropResumeStartup
} from './ai-vault-drop-resume-startup'

vi.mock('@/lib/new-workspace', () => ({
  CLIENT_PLATFORM: 'darwin'
}))

const RECORDED_HOME = '/tmp/orca/codex-accounts/aaaa/home'
const SELECTED_HOME = '/tmp/orca/codex-accounts/bbbb/home'

type DropRepinState = Pick<
  AppState,
  | 'activeRepoId'
  | 'activeWorktreeId'
  | 'folderWorkspaces'
  | 'projectGroups'
  | 'projects'
  | 'repos'
  | 'settings'
  | 'worktreesByRepo'
>

function makeState(): DropRepinState {
  return {
    activeRepoId: 'repo-1',
    activeWorktreeId: 'repo-1::worktree-1',
    folderWorkspaces: [],
    projectGroups: [],
    repos: [{ id: 'repo-1', path: '/Users/ada/repo' }],
    projects: [{ id: 'repo-1', sourceRepoIds: ['repo-1'] }],
    settings: {
      agentDefaultArgs: { claude: '', codex: '' },
      agentDefaultEnv: { claude: {}, codex: {} }
    },
    worktreesByRepo: {
      'repo-1': [{ id: 'repo-1::worktree-1', repoId: 'repo-1', path: '/Users/ada/repo' }]
    }
  } as unknown as DropRepinState
}

vi.stubGlobal('window', {
  api: {
    shell: { pathExists: vi.fn().mockResolvedValue(true) },
    fs: { pathExists: vi.fn().mockResolvedValue(true) }
  }
})

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
  it('repins a payload with a cwd to the substituted home', async () => {
    const startup = await buildAiVaultDropRepinStartup({
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

  it('repins a payload whose session has no cwd instead of keeping the wrong-account command', async () => {
    const startup = await buildAiVaultDropRepinStartup({
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

  it('declines a payload from an older serializer that never carried sessionCwd', async () => {
    const startup = await buildAiVaultDropRepinStartup({
      state: makeState(),
      payload: payload({}),
      substituteCodexHome: SELECTED_HOME,
      worktreeId: 'repo-1::worktree-1'
    })

    expect(startup).toBeNull()
  })

  it('repins a deleted nested cwd to the selected workspace root', async () => {
    const pathExists = vi.mocked(window.api.shell.pathExists)
    pathExists.mockResolvedValueOnce(false)

    const startup = await buildAiVaultDropRepinStartup({
      state: makeState(),
      payload: payload({ sessionCwd: '/Users/ada/repo/packages/deleted' }),
      substituteCodexHome: SELECTED_HOME,
      worktreeId: 'repo-1::worktree-1'
    })

    expect(startup).toMatchObject({ cwd: '/Users/ada/repo' })
    expect(startup?.command).not.toContain('/packages/deleted')
  })

  it('rebuilds a current drag payload with the async cwd check', async () => {
    const pathExists = vi.mocked(window.api.shell.pathExists)
    pathExists.mockResolvedValueOnce(false)

    const startup = await buildAiVaultDropResumeStartup({
      state: makeState(),
      payload: {
        ...payload({ sessionCwd: '/Users/ada/repo/packages/deleted' }),
        codexHome: SELECTED_HOME
      },
      codexHome: SELECTED_HOME,
      worktreeId: 'repo-1::worktree-1'
    })

    expect(startup).toMatchObject({ cwd: '/Users/ada/repo' })
    expect(startup?.command).not.toContain('/packages/deleted')
  })

  it('launches current drag payloads through the async startup resolver', async () => {
    const pathExists = vi.mocked(window.api.shell.pathExists)
    pathExists.mockResolvedValueOnce(false)

    const startup = await buildAiVaultDropLaunchStartup({
      state: makeState(),
      payload: {
        ...payload({ sessionCwd: '/Users/ada/repo/packages/deleted' }),
        title: 'Session',
        command: "cd '/Users/ada/repo/packages/deleted' && codex resume session-1",
        codexHome: SELECTED_HOME
      },
      useRealCodexHome: false,
      worktreeId: 'repo-1::worktree-1'
    })

    expect(startup).toMatchObject({ cwd: '/Users/ada/repo' })
    expect(startup?.command).not.toContain('/packages/deleted')
  })
})
