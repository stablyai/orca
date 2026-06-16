import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { GitHubRateLimitPanel } from '@/components/github/github-rate-limit-display'
import { GitLabRateLimitPanel } from '@/components/gitlab/gitlab-rate-limit-display'

type StoreState = {
  settings: { activeRuntimeEnvironmentId: string | null }
  openSettingsPage: () => void
  openSettingsTarget: (target: { pane: string; repoId: string | null }) => void
}

const mocks = vi.hoisted(() => ({
  store: {
    current: {
      settings: { activeRuntimeEnvironmentId: null },
      openSettingsPage: vi.fn(),
      openSettingsTarget: vi.fn()
    } as StoreState
  }
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: StoreState) => unknown) => selector(mocks.store.current)
}))

describe('provider rate-limit panels account scope', () => {
  it('shows the local host scope for GitHub API budget', () => {
    mocks.store.current = {
      settings: { activeRuntimeEnvironmentId: null },
      openSettingsPage: vi.fn(),
      openSettingsTarget: vi.fn()
    }

    const markup = renderToStaticMarkup(<GitHubRateLimitPanel />)

    expect(markup).toContain('Budget scope: Local Mac')
    expect(markup).toContain(
      'GitHub API budget is fetched from the CLI on this desktop client. Use Settings &gt; Remote Orca Servers &gt; Advanced to view server-owned budgets.'
    )
    expect(markup).toContain('Open Remote Servers')
  })

  it('shows the remote server scope for GitLab API budget', () => {
    mocks.store.current = {
      settings: { activeRuntimeEnvironmentId: 'runtime-1' },
      openSettingsPage: vi.fn(),
      openSettingsTarget: vi.fn()
    }

    const markup = renderToStaticMarkup(<GitLabRateLimitPanel />)

    expect(markup).toContain('Budget scope: Remote server: runtime-1')
    expect(markup).toContain(
      'GitLab API budget is fetched from the CLI on this remote server. Use Settings &gt; Remote Orca Servers &gt; Advanced to view another default runtime budget.'
    )
  })
})
