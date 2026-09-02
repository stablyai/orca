import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import {
  buildAiVaultResumeCopyCommandForWorktree,
  buildAiVaultResumeStartupForWorktree
} from './ai-vault-resume-command'

vi.mock('@/lib/new-workspace', () => ({
  CLIENT_PLATFORM: 'darwin'
}))

type ResumableAgentState = Pick<
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

function makeState(): ResumableAgentState {
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
  } as unknown as ResumableAgentState
}

const KIMI_SESSION = {
  agent: 'kimi' as const,
  sessionId: 'session_431324d7-2165-42f0-9ecd-9f93437b3201',
  cwd: '/Users/ada/repo/packages/api',
  codexHome: null
}

describe('AI Vault resume for Kimi', () => {
  it('keeps the cd prefix on the copied resume line', () => {
    // Why: Kimi sessions are work-dir-scoped — resuming from the worktree root instead of the
    // session's own cwd fails with "created under a different directory".
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
    // Why: the plan branch applies Kimi's default launch args, so a resumed pane starts with the
    // same permission flag Orca gives a fresh one.
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
