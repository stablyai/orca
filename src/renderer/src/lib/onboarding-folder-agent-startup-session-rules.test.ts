// Coverage for the repo-scoped agent-session-rules gap in the onboarding
// folder-agent-startup path: `buildOnboardingFolderAgentStartup` must thread
// the caller's repoId/connectionId/executionHostId into `buildAgentStartupPlan`,
// matching the wiring `launch-work-item-direct.ts` already has.

import { beforeEach, describe, expect, it } from 'vitest'
import { vi } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'

const store = {
  settings: {
    agentSessionRules: { enabled: false, rules: [] as unknown[] }
  } as { agentSessionRules?: { enabled: boolean; rules: unknown[] } },
  repos: [
    {
      id: 'repo-1',
      connectionId: null as string | null,
      path: '/repo',
      agentSessionRules: undefined as
        | {
            enabled?: boolean
            extraRules?: {
              id: string
              label: string
              content: string
              enabled: boolean
              source: 'custom'
            }[]
          }
        | undefined
    }
  ]
}

vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))

describe('buildOnboardingFolderAgentStartup agent-session-rules threading', () => {
  beforeEach(() => {
    store.settings = { agentSessionRules: { enabled: false, rules: [] } }
    store.repos = [
      { id: 'repo-1', connectionId: null, path: '/repo', agentSessionRules: undefined }
    ]
  })

  it('threads the passed repo context into agent-session-rules resolution', async () => {
    store.repos = [
      {
        id: 'repo-1',
        connectionId: null,
        path: '/repo',
        agentSessionRules: {
          enabled: true,
          extraRules: [
            {
              id: 'custom-repo-rule',
              label: 'Repo rule',
              content: 'ONBOARDING FOLDER REPO ONLY RULE TEXT',
              enabled: true,
              source: 'custom'
            }
          ]
        }
      }
    ]
    const { getDefaultSettings } = await import('../../../shared/constants')
    const { buildOnboardingFolderAgentStartup } = await import('./onboarding-folder-agent-startup')

    // Why: claude injects session rules natively via --append-system-prompt on
    // an empty-prompt launch, so a correctly-threaded repoId surfaces here.
    const startup = buildOnboardingFolderAgentStartup(
      { ...getDefaultSettings('/tmp/orca-workspaces'), defaultTuiAgent: 'claude' },
      true,
      'repo-1',
      null,
      LOCAL_EXECUTION_HOST_ID
    )

    expect(startup?.command).toContain('ONBOARDING FOLDER REPO ONLY RULE TEXT')
  })

  it('omits repo-only rules when no repo context is passed', async () => {
    store.repos = [
      {
        id: 'repo-1',
        connectionId: null,
        path: '/repo',
        agentSessionRules: {
          enabled: true,
          extraRules: [
            {
              id: 'custom-repo-rule',
              label: 'Repo rule',
              content: 'ONBOARDING FOLDER REPO ONLY RULE TEXT',
              enabled: true,
              source: 'custom'
            }
          ]
        }
      }
    ]
    const { getDefaultSettings } = await import('../../../shared/constants')
    const { buildOnboardingFolderAgentStartup } = await import('./onboarding-folder-agent-startup')

    const startup = buildOnboardingFolderAgentStartup({
      ...getDefaultSettings('/tmp/orca-workspaces'),
      defaultTuiAgent: 'claude'
    })

    expect(startup?.command).not.toContain('ONBOARDING FOLDER REPO ONLY RULE TEXT')
  })
})
