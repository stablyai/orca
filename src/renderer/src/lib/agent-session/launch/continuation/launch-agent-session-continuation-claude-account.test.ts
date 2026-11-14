import { beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import { getDefaultSettings } from '../../../../../../shared/constants'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import type { Repo } from '../../../../../../shared/repo-types'
import { launchAgentSessionContinuation } from './launch-agent-session-continuation'
import type { LaunchAgentInNewTabArgs } from '../new-tab/launch-agent-in-new-tab-args'
import type { LaunchAgentInNewTabResult } from '../new-tab/launch-agent-in-new-tab-host-agents'

const mocks = vi.hoisted(() => ({
  launch: vi.fn<(args: LaunchAgentInNewTabArgs) => LaunchAgentInNewTabResult>()
}))
vi.mock('@/lib/agent-session/launch/new-tab/launch-agent-in-new-tab', () => ({
  launchAgentInNewTabWithOutcome: mocks.launch
}))
vi.mock('../inventory/host-chat-program-acquisition', () => ({
  acquireAgentLaunchChoices: async () => ({ detected: ['claude'], offered: ['claude'] })
}))

function useRepo(agentAccounts: Repo['agentAccounts']): void {
  useAppStore.setState({
    settings: getDefaultSettings('/test'),
    repos: [
      {
        id: 'repo-1',
        path: '/repo',
        displayName: 'Repo',
        badgeColor: '',
        addedAt: 0,
        agentAccounts
      }
    ],
    worktreesByRepo: {
      'repo-1': [makeWorktree({ id: 'target', repoId: 'repo-1', path: '/repo/t', hostId: 'local' })]
    }
  })
}

async function continueInChat(): Promise<LaunchAgentInNewTabArgs | undefined> {
  await launchAgentSessionContinuation({
    agent: 'claude',
    prompt: 'Continue the saved task',
    worktreeId: 'target',
    launchSource: 'sidebar',
    launchChoice: { agent: 'claude', route: 'structured-native-chat', executionHostId: 'local' }
  })
  return mocks.launch.mock.calls[0]?.[0]
}

beforeEach(() => {
  mocks.launch.mockReset()
  mocks.launch.mockReturnValue(null)
})

it('opens a terminal instead of the picked chat when the project pins a Claude account', async () => {
  useRepo({ claude: { mode: 'account', accountId: 'acct-1' } })

  const launched = await continueInChat()

  expect(launched?.agentSessionLaunchPlan?.route).toBe('terminal-tui')
})

it('keeps the picked chat when the project has no saved Claude account', async () => {
  useRepo(undefined)

  const launched = await continueInChat()

  expect(launched?.agentSessionLaunchPlan?.route).toBe('structured-native-chat')
})
