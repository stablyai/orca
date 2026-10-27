import { getDefaultSettings } from '../../../shared/constants'
import { TEST_REPO, makeWorktree } from '../store/slices/worktrees-slice-test-fixtures'
import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import { buildAiVaultForkStartupForWorktree } from './ai-vault-session-fork-startup'

vi.mock('@/lib/new-workspace', () => ({
  CLIENT_PLATFORM: 'darwin'
}))

type ForkState = Pick<
  AppState,
  | 'activeRepoId'
  | 'activeWorktreeId'
  | 'folderWorkspaces'
  | 'projectGroups'
  | 'endpointProjects'
  | 'endpointProjectHostSetups'
  | 'repos'
  | 'settings'
  | 'worktreesByRepo'
>

function makeState(): ForkState {
  return {
    activeRepoId: 'repo-1',
    activeWorktreeId: 'repo-1::worktree-1',
    folderWorkspaces: [],
    projectGroups: [],
    repos: [{ ...TEST_REPO, id: 'repo-1', path: '/Users/ada/repo' }],
    endpointProjects: [
      {
        id: 'repo-1',
        displayName: 'repo',
        badgeColor: '',
        sourceRepoIds: ['repo-1'],
        createdAt: 0,
        updatedAt: 0
      }
    ],
    endpointProjectHostSetups: [],
    settings: {
      ...getDefaultSettings('/tmp'),
      agentPermissionDefault: 'own',
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

const SESSION_ID = '019fd532-7c11-7a90-b6de-4e1a2c3d5f60'

describe('AI Vault fork into the CLI', () => {
  it('forks Claude in the recorded folder without claiming the chat-owned session', () => {
    const startup = buildAiVaultForkStartupForWorktree({
      state: makeState(),
      worktreeId: 'repo-1::worktree-1',
      session: { agent: 'claude', sessionId: SESSION_ID, cwd: '/Users/ada/repo', codexHome: null }
    })

    expect(startup).toMatchObject({
      command: `claude '--resume' '${SESSION_ID}' '--fork-session'`,
      cwd: '/Users/ada/repo'
    })
    // A cold restore of the tab must never re-enter the conversation the chat still owns.
    expect(startup).not.toHaveProperty('providerSession')
  })

  it('forks Codex under the home the transcript was found in', () => {
    const startup = buildAiVaultForkStartupForWorktree({
      state: makeState(),
      worktreeId: 'repo-1::worktree-1',
      session: {
        agent: 'codex',
        sessionId: SESSION_ID,
        cwd: '/Users/ada/repo',
        codexHome: '/Users/ada/.orca/codex-accounts/a1/home'
      }
    })

    expect(startup?.command).toBe(
      `CODEX_HOME='/Users/ada/.orca/codex-accounts/a1/home' codex '-c' 'tui.resume_cwd=current' 'fork' '${SESSION_ID}'`
    )
    expect(startup).not.toHaveProperty('providerSession')
  })

  it('returns null for an agent that cannot fork instead of a plain resume', () => {
    expect(
      buildAiVaultForkStartupForWorktree({
        state: makeState(),
        worktreeId: 'repo-1::worktree-1',
        session: { agent: 'gemini', sessionId: SESSION_ID, cwd: '/Users/ada/repo', codexHome: null }
      })
    ).toBeNull()
  })
})
