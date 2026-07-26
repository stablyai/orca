import { describe, expect, it } from 'vitest'
import type { AppState } from '@/store/types'
import { createTestStore, makeTab } from '@/store/slices/store-test-helpers'
import { buildAgentResumeStartupPlan } from './tui-agent-startup'
import { buildAiVaultResumeStartupForWorktree } from './ai-vault-resume-command'

describe('AI Vault OMP cold resume', () => {
  it('keeps the custom session store after the resumed process reports its id', () => {
    const store = createTestStore()
    store.setState({
      activeRepoId: 'repo-1',
      activeWorktreeId: 'wt-1',
      folderWorkspaces: [],
      projectGroups: [],
      projects: [{ id: 'repo-1', sourceRepoIds: ['repo-1'] }],
      repos: [{ id: 'repo-1', path: '/repo' }],
      settings: {
        agentDefaultArgs: { omp: '--model custom' },
        agentDefaultEnv: { omp: { OMP_PROFILE: 'custom' } }
      } as unknown as NonNullable<AppState['settings']>,
      tabsByWorktree: {
        'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })]
      },
      worktreesByRepo: {
        'repo-1': [{ id: 'wt-1', repoId: 'repo-1', path: '/repo' }]
      }
    } as unknown as Partial<AppState>)

    const startup = buildAiVaultResumeStartupForWorktree({
      state: store.getState(),
      worktreeId: 'wt-1',
      session: {
        agent: 'omp',
        sessionId: 'omp-session-1',
        filePath: '/custom/omp-sessions/project/session.jsonl',
        cwd: '/repo',
        codexHome: null
      }
    })

    expect(startup).toMatchObject({
      command:
        "cd '/repo' && omp '--model' 'custom' --resume '/custom/omp-sessions/project/session.jsonl'",
      env: { OMP_PROFILE: 'custom' },
      launchConfig: {
        agentCommand: "omp '--model' 'custom'",
        agentArgs: '--model custom',
        agentEnv: { OMP_PROFILE: 'custom' },
        ompResumeFilePath: '/custom/omp-sessions/project/session.jsonl'
      },
      providerSession: { key: 'session_id', id: 'omp-session-1' }
    })

    store.getState().registerAgentLaunchConfig('tab-1:leaf-1', startup.launchConfig!, {
      agentType: 'omp',
      launchToken: 'launch-1',
      tabId: 'tab-1',
      leafId: 'leaf-1'
    })
    store
      .getState()
      .recordAgentProviderSession(
        'tab-1:leaf-1',
        'omp',
        startup.providerSession!,
        { updatedAt: 10 },
        { tabId: 'tab-1', worktreeId: 'wt-1' },
        { launchToken: 'launch-1' }
      )
    store
      .getState()
      .setAgentStatus(
        'tab-1:leaf-1',
        { state: 'working', prompt: 'resume', agentType: 'omp' },
        'OMP',
        { updatedAt: 20, stateStartedAt: 20 },
        { tabId: 'tab-1', worktreeId: 'wt-1' },
        { providerSession: startup.providerSession, launchToken: 'launch-1' }
      )
    store.getState().captureAllSleepingAgentSessions('quit')

    const record = store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']!
    const coldStartup = buildAgentResumeStartupPlan({
      agent: record.agent,
      providerSession: record.providerSession,
      cmdOverrides: {},
      agentArgs: record.launchConfig?.agentArgs,
      agentEnv: record.launchConfig?.agentEnv,
      agentCommand: record.launchConfig?.agentCommand,
      ompResumeFilePath: record.launchConfig?.ompResumeFilePath,
      platform: 'linux'
    })

    expect(record).toMatchObject({
      providerSession: { key: 'session_id', id: 'omp-session-1' },
      launchConfig: {
        agentEnv: { OMP_PROFILE: 'custom' },
        ompResumeFilePath: '/custom/omp-sessions/project/session.jsonl'
      },
      origin: 'quit'
    })
    expect(coldStartup).toMatchObject({
      launchCommand:
        "omp '--model' 'custom' '--resume' '/custom/omp-sessions/project/session.jsonl'",
      env: { OMP_PROFILE: 'custom' }
    })
  })
})
