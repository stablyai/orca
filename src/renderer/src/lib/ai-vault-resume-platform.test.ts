import { describe, expect, it, vi } from 'vitest'
import type { RuntimeEnvironmentStatus } from '../../../shared/runtime-host-status'
import { getDefaultSettings } from '../../../shared/constants'
import { makeWorktree } from '../store/slices/worktrees-slice-test-fixtures'
import {
  getAiVaultResumePlatform,
  type AiVaultResumePlatformState
} from './ai-vault-resume-platform'
import { buildAiVaultDropRepinStartup } from './ai-vault-resume-command'

vi.mock('@/lib/new-workspace', () => ({ CLIENT_PLATFORM: 'darwin' }))

const WORKTREE_ID = 'repo-1::/srv/repo'

function serverReporting(
  hostPlatform: NodeJS.Platform | undefined
): Map<string, RuntimeEnvironmentStatus> {
  return new Map([
    [
      'server',
      {
        checkedAt: 1,
        status: {
          runtimeId: 'rt',
          rendererGraphEpoch: 0,
          graphStatus: 'ready',
          authoritativeWindowId: null,
          liveTabCount: 0,
          liveLeafCount: 0,
          ...(hostPlatform ? { hostPlatform } : {})
        }
      }
    ]
  ])
}

function pairedServerState(hostPlatform: NodeJS.Platform | undefined): AiVaultResumePlatformState {
  return {
    activeRepoId: 'repo-1',
    activeWorktreeId: WORKTREE_ID,
    detectedWorktreesByRepo: {},
    sshConnectionStates: new Map(),
    sshStateByEnvironment: new Map(),
    runtimeStatusByEnvironmentId: serverReporting(hostPlatform),
    folderWorkspaces: [],
    projectGroups: [],
    projects: [],
    repos: [
      {
        id: 'repo-1',
        path: '/srv/repo',
        displayName: 'repo',
        badgeColor: '',
        addedAt: 0,
        executionHostId: 'runtime:server'
      }
    ],
    settings: {
      ...getDefaultSettings('/tmp'),
      agentDefaultArgs: { claude: '', codex: '' },
      agentDefaultEnv: { claude: {}, codex: {} }
    },
    worktreesByRepo: {
      'repo-1': [makeWorktree({ id: WORKTREE_ID, repoId: 'repo-1', path: '/srv/repo' })]
    }
  }
}

// Why: a saved session resumed on a paired server runs on that server's OS, not a guessed Linux.
describe('AI-vault resume on a paired server', () => {
  it.each([
    ['win32', 'win32'],
    ['linux', 'linux'],
    [undefined, null]
  ] as const)('reads a server reporting %s as %s', (reported, expected) => {
    expect(getAiVaultResumePlatform(pairedServerState(reported), WORKTREE_ID)).toBe(expected)
  })

  it.each([
    [
      'win32',
      "$env:CODEX_HOME='/srv/codex-home'; codex '-c' 'tui.resume_cwd=current' 'resume' 'session-1'"
    ],
    [
      undefined,
      "CODEX_HOME='/srv/codex-home' codex '-c' 'tui.resume_cwd=current' 'resume' 'session-1'"
    ]
  ] as const)(
    'quotes a dropped session for a server on %s and keeps Unix-only Codex flags off',
    (reported, resumeLine) => {
      const startup = buildAiVaultDropRepinStartup({
        state: pairedServerState(reported),
        worktreeId: WORKTREE_ID,
        substituteCodexHome: '/srv/codex-home',
        payload: {
          agent: 'codex',
          sessionId: 'session-1',
          sessionCwd: null,
          sessionExecutionHostId: 'runtime:server',
          sessionFilePath: '/srv/codex-home/sessions/rollout-x.jsonl'
        }
      })

      expect(startup?.command).toContain(resumeLine)
      expect(startup?.command).not.toContain('disable_paste_burst')
    }
  )

  it('keeps the Unix-only Codex flag for a server that reports Linux', () => {
    const startup = buildAiVaultDropRepinStartup({
      state: pairedServerState('linux'),
      worktreeId: WORKTREE_ID,
      substituteCodexHome: '/srv/codex-home',
      payload: {
        agent: 'codex',
        sessionId: 'session-1',
        sessionCwd: null,
        sessionExecutionHostId: 'runtime:server',
        sessionFilePath: '/srv/codex-home/sessions/rollout-x.jsonl'
      }
    })

    expect(startup?.command).toContain("codex '-c' 'disable_paste_burst=true'")
  })
})
