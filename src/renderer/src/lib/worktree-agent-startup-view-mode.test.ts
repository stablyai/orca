import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import type { TuiAgent } from '../../../shared/tui-agent'
import { backendAgentStartup } from './worktree-agent-startup-view-mode'

const initialSettings = useAppStore.getState().settings!
const initialRepos = useAppStore.getState().repos

const DRAFT = 'https://github.com/o/r/issues/12'

function setRepoConnection(connectionId: string | null): void {
  useAppStore.setState({
    repos: [
      {
        id: 'repo-1',
        path: '/repo',
        displayName: 'repo',
        badgeColor: '#000',
        addedAt: 1,
        connectionId
      }
    ]
  })
}

function startupFor(agent: TuiAgent, launchDraftPrompt?: string) {
  return backendAgentStartup({
    repoId: 'repo-1',
    agent,
    startup: { command: agent },
    ...(launchDraftPrompt ? { launchDraftPrompt } : {})
  })
}

beforeEach(() => {
  useAppStore.setState({
    settings: {
      ...initialSettings,
      experimentalNativeChat: true,
      openAgentTabsInChatByDefault: true
    }
  })
})

afterEach(() => {
  useAppStore.setState({ settings: initialSettings, repos: initialRepos })
})

describe('backendAgentStartup', () => {
  it("sends this device's chat default for the host to gate on its own route", () => {
    // The host owns transcript readability, so a Model-A SSH omp draft is not pinned here.
    for (const connectionId of [null, 'ssh-target-1', 'runtime-ssh-env-1']) {
      setRepoConnection(connectionId)
      const startup = startupFor('omp', DRAFT)
      expect(startup?.launcherDefaultView).toBe('chat')
      expect(startup).not.toHaveProperty('viewMode')
    }
  })

  it('pins terminal for a draft chat cannot mirror, whatever the default', () => {
    setRepoConnection(null)
    expect(startupFor('claude', 'note\u2028issue')).toMatchObject({
      viewMode: 'terminal',
      launcherDefaultView: 'chat'
    })
  })
})

describe('backendAgentStartup for a launch with no draft (STA-6412)', () => {
  it("sends this device's chat default on a prompt-less agent startup", () => {
    setRepoConnection(null)
    expect(startupFor('claude')?.launcherDefaultView).toBe('chat')
  })

  it("sends this device's terminal default, never a decided terminal", () => {
    setRepoConnection(null)
    useAppStore.setState({
      settings: {
        ...initialSettings,
        experimentalNativeChat: true,
        openAgentTabsInChatByDefault: false
      }
    })
    const startup = startupFor('claude')
    expect(startup?.launcherDefaultView).toBe('terminal')
    expect(startup).not.toHaveProperty('viewMode')
  })
})
