// @vitest-environment happy-dom

import { withBotConnectorRuntime } from './bot-connector-host-calls.test-fixture'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { BrowserPage } from '../../../shared/browser/workspaces/browser-workspace-types'
import {
  awaitGitHubChange,
  readBotGitHub,
  readGitHubAwait,
  refreshBotGitHub
} from './bot-github-state'

const linked = {
  installUrl: 'https://connector.example/github/install?state=s',
  account: { userId: '42', login: 'dana' },
  installations: [],
  defaultBotId: null
}
const state = vi.fn()

function signIn(userId: string | null): void {
  useAppStore.setState({
    orcaProfileAuthStatus: userId
      ? {
          activeProfileId: 'p',
          configured: true,
          state: 'connected',
          persistence: 'encrypted',
          cloud: { cloudProfileId: 'c', userId, email: 'e@x.dev', linkedAt: 1 }
        }
      : null
  })
}

beforeEach(() => {
  state.mockReset()
  Object.assign(window, { api: withBotConnectorRuntime({ botGitHub: { state } }) })
})

afterEach(() => {
  Reflect.deleteProperty(window, 'api')
})

describe('bot GitHub state', () => {
  it('reads a cloud that answers its GitHub routes 404 as off', async () => {
    state.mockResolvedValue({ ok: false, error: 'github_off' })
    expect(await refreshBotGitHub('local')).toEqual({ status: 'off' })
  })

  it('forgets the last account’s link the moment another Orca account signs in', async () => {
    signIn('ada')
    state.mockResolvedValue({ ok: true, value: linked })
    await refreshBotGitHub('local')
    expect(readBotGitHub('local')).toMatchObject({ status: 'ready' })

    signIn('bo')
    expect(readBotGitHub('local')).toEqual({ status: 'loading' })
  })

  it('drops an answer asked for before the account changed', async () => {
    signIn('ada')
    let answer: (value: unknown) => void = () => {}
    state.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    const asked = refreshBotGitHub('local')
    signIn('bo')
    answer({ ok: true, value: linked })
    await asked
    expect(readBotGitHub('local')).toEqual({ status: 'loading' })
  })

  it('stops checking with nothing new once the wait runs out, and clears when GitHub changes', async () => {
    vi.useFakeTimers()
    try {
      signIn('cy')
      state.mockResolvedValue({ ok: true, value: linked })
      await refreshBotGitHub('local')
      void awaitGitHubChange('local', 60_000)
      expect(readGitHubAwait('local')).toBe('checking')
      await vi.advanceTimersByTimeAsync(70_000)
      expect(readGitHubAwait('local')).toBe('unchanged')
      await refreshBotGitHub('local')
      expect(readGitHubAwait('local')).toBe('unchanged')

      void awaitGitHubChange('local', 60_000)
      state.mockResolvedValue({
        ok: true,
        value: {
          ...linked,
          installations: [{ installationId: '9', accountLogin: 'acme', repositories: null }]
        }
      })
      await vi.advanceTimersByTimeAsync(5_000)
      expect(readGitHubAwait('local')).toBe(null)
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops an expired wait’s "nothing new" once a later read finds the change', async () => {
    vi.useFakeTimers()
    try {
      signIn('di')
      state.mockResolvedValue({ ok: true, value: linked })
      await refreshBotGitHub('local')
      void awaitGitHubChange('local', 60_000)
      await vi.advanceTimersByTimeAsync(70_000)
      expect(readGitHubAwait('local')).toBe('unchanged')

      state.mockResolvedValue({
        ok: true,
        value: {
          ...linked,
          installations: [{ installationId: '9', accountLogin: 'acme', repositories: null }]
        }
      })
      await refreshBotGitHub('local')
      expect(readGitHubAwait('local')).toBe(null)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reads at once when a page in Orca’s browser lands on GitHub’s setup URL', async () => {
    vi.useFakeTimers()
    const pages = (url: string): Record<string, BrowserPage[]> => ({
      ws: [
        {
          id: 'page-1',
          workspaceId: 'ws',
          worktreeId: 'wt',
          url,
          title: '',
          loading: false,
          faviconUrl: null,
          canGoBack: false,
          canGoForward: false,
          loadError: null,
          createdAt: 1
        }
      ]
    })
    try {
      signIn('ed')
      state.mockResolvedValue({ ok: true, value: linked })
      await refreshBotGitHub('local')
      useAppStore.setState({
        browserPagesByWorkspace: pages('https://github.com/apps/orca-ide/installations/new')
      })
      void awaitGitHubChange('local', 60_000)
      await vi.advanceTimersByTimeAsync(0)
      const reads = state.mock.calls.length

      state.mockResolvedValue({
        ok: true,
        value: {
          ...linked,
          installations: [{ installationId: '9', accountLogin: 'acme', repositories: null }]
        }
      })
      useAppStore.setState({
        browserPagesByWorkspace: pages(
          'https://connector.example/github/install/callback?installation_id=9&setup_action=install&state=x'
        )
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(state.mock.calls.length).toBe(reads + 1)
      expect(readGitHubAwait('local')).toBe(null)
    } finally {
      useAppStore.setState({ browserPagesByWorkspace: {} })
      vi.useRealTimers()
    }
  })
})
