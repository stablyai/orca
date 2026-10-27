import { getDefaultSettings } from '../../../shared/constants'
import { TEST_REPO, makeWorktree } from '../store/slices/worktrees-slice-test-fixtures'
import { describe, expect, it, vi } from 'vitest'
import {
  buildAiVaultResumeCopyCommandForWorktree,
  buildAiVaultResumeStartupForWorktree
} from './ai-vault-resume-command'

vi.mock('@/lib/new-workspace', () => ({
  CLIENT_PLATFORM: 'darwin'
}))

type ResumableAgentState = Parameters<typeof buildAiVaultResumeCopyCommandForWorktree>[0]['state']

function makeState(): ResumableAgentState {
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

const KIMI_SESSION = {
  agent: 'kimi' as const,
  sessionId: 'session_431324d7-2165-42f0-9ecd-9f93437b3201',
  cwd: '/Users/ada/repo/packages/api',
  codexHome: null
}

describe('AI Vault resume for Kimi', () => {
  it('keeps the cd prefix on the copied resume line', () => {
    // Kimi must resume from its recorded cwd or it rejects the session as created elsewhere.
    expect(
      buildAiVaultResumeCopyCommandForWorktree({
        state: makeState(),
        worktreeId: 'repo-1::worktree-1',
        session: KIMI_SESSION
      })
    ).toBe(
      "cd '/Users/ada/repo/packages/api' && kimi '--yolo' '--session' 'session_431324d7-2165-42f0-9ecd-9f93437b3201'"
    )
  })

  it('takes the resumable-agent startup plan so the pane claims the provider session', () => {
    // Apply Kimi’s default permission arguments to resumes as to fresh launches.
    expect(
      buildAiVaultResumeStartupForWorktree({
        state: makeState(),
        worktreeId: 'repo-1::worktree-1',
        session: KIMI_SESSION
      })
    ).toMatchObject({
      command: "kimi '--yolo' '--session' 'session_431324d7-2165-42f0-9ecd-9f93437b3201'",
      cwd: '/Users/ada/repo/packages/api',
      launchConfig: { agentCommand: "kimi '--yolo'" },
      providerSession: {
        key: 'session_id',
        id: 'session_431324d7-2165-42f0-9ecd-9f93437b3201'
      }
    })
  })
})
