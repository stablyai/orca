import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PreflightStatus } from '../../../../preload/api-types'
import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'
import { ConnectIntegrationsList } from './ConnectIntegrationsList'

type StoreState = {
  activeRepoId: string | null
  activeWorktreeId: string | null
  worktreesByRepo: Record<string, unknown[]>
  repos: unknown[]
  settings: { activeRuntimeEnvironmentId?: string | null }
  preflightStatus: PreflightStatus | null
  preflightStatusChecked: boolean
  preflightStatusContextKey: string
  preflightStatusError: string | null
  preflightStatusLoading: boolean
  refreshPreflightStatus: () => Promise<void>
  linearStatus: { connected: boolean; workspaces?: unknown[] }
  linearStatusChecked: boolean
  linearStatusContextKey: string | null
  checkLinearConnection: () => Promise<void>
  testLinearConnection: () => Promise<{ ok: boolean; error?: string }>
  disconnectLinear: () => Promise<void>
  disconnectLinearWorkspace: () => Promise<void>
  jiraStatus: { connected: boolean; sites?: unknown[] }
  jiraStatusChecked: boolean
  jiraStatusContextKey: string | null
  checkJiraConnection: () => Promise<void>
  testJiraConnection: () => Promise<{ ok: boolean; error?: string }>
  disconnectJira: () => Promise<void>
}

const { storeState } = vi.hoisted(() => ({
  storeState: { current: null as StoreState | null }
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: StoreState) => unknown) => {
      if (!storeState.current) {
        throw new Error('Store state was not installed')
      }
      return selector(storeState.current)
    },
    { getState: () => storeState.current }
  )
}))

vi.mock('@/components/linear-api-key-dialog', () => ({
  LinearApiKeyDialog: () => null
}))

vi.mock('@/components/jira-connect-dialog', () => ({
  JiraConnectDialog: () => null
}))

function makePreflightStatus(overrides: Partial<PreflightStatus> = {}): PreflightStatus {
  const status: PreflightStatus = {
    git: { installed: true },
    gh: { installed: true, authenticated: false },
    glab: { installed: true, authenticated: false },
    bitbucket: {
      configured: false,
      authenticated: false,
      account: null
    },
    azureDevOps: {
      configured: false,
      authenticated: false,
      account: null,
      baseUrl: null,
      tokenConfigured: false
    },
    gitea: {
      configured: false,
      authenticated: false,
      account: null,
      baseUrl: null,
      tokenConfigured: false
    }
  }
  return { ...status, ...overrides }
}

function installStore(preflightStatus: PreflightStatus): void {
  const settings = { activeRuntimeEnvironmentId: null }
  const providerContextKey = getProviderRuntimeContextKey(settings)
  storeState.current = {
    activeRepoId: null,
    activeWorktreeId: null,
    worktreesByRepo: {},
    repos: [],
    settings,
    preflightStatus,
    preflightStatusChecked: true,
    preflightStatusContextKey: 'host',
    preflightStatusError: null,
    preflightStatusLoading: false,
    refreshPreflightStatus: vi.fn(async () => {}),
    linearStatus: { connected: false, workspaces: [] },
    linearStatusChecked: true,
    linearStatusContextKey: providerContextKey,
    checkLinearConnection: vi.fn(async () => {}),
    testLinearConnection: vi.fn(async () => ({ ok: true })),
    disconnectLinear: vi.fn(async () => {}),
    disconnectLinearWorkspace: vi.fn(async () => {}),
    jiraStatus: { connected: false, sites: [] },
    jiraStatusChecked: true,
    jiraStatusContextKey: providerContextKey,
    checkJiraConnection: vi.fn(async () => {}),
    testJiraConnection: vi.fn(async () => ({ ok: true })),
    disconnectJira: vi.fn(async () => {})
  }
}

async function renderConnectIntegrationsList(): Promise<{
  markup: string
}> {
  return { markup: renderToStaticMarkup(<ConnectIntegrationsList />) }
}

describe('ConnectIntegrationsList', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {
      api: {
        shell: {
          openUrl: vi.fn()
        }
      }
    })
  })

  afterEach(() => {
    storeState.current = null
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('renders the settings review cards in the review step without an inline auth terminal', async () => {
    installStore(makePreflightStatus())

    const { markup } = await renderConnectIntegrationsList()

    for (const provider of ['GitHub', 'GitLab', 'Bitbucket', 'Azure DevOps', 'Gitea']) {
      expect(markup).toContain(provider)
    }
    expect(markup).toContain('gh auth login')
    expect(markup).toContain('glab auth login')
    expect(markup).not.toContain('Run in terminal')
  })

  it('keeps the upcoming task step collapsed but openable, not inert', async () => {
    installStore(makePreflightStatus())

    const { markup } = await renderConnectIntegrationsList()

    // Review is optional ordering: tracker-first users can expand the task step.
    expect(markup).toContain('Open')
    expect(markup).not.toContain('opacity-55')
    expect(markup).not.toContain('Add Linear access')
  })

  it('collapses the task step to its summary when a tracker connects first', async () => {
    installStore(makePreflightStatus())
    if (!storeState.current) {
      throw new Error('Store state was not installed')
    }
    storeState.current.linearStatus = { connected: true, workspaces: [] }

    const { markup } = await renderConnectIntegrationsList()

    expect(markup).toContain('connected for tasks')
    expect(markup).not.toContain('Connect Jira')
  })

  it('auto-resolves the task step from a connected code host but keeps it open for trackers', async () => {
    installStore(makePreflightStatus({ gh: { installed: true, authenticated: true } }))

    const { markup } = await renderConnectIntegrationsList()

    expect(markup).toContain('GitHub')
    expect(markup).toContain('issues available as tasks')
    expect(markup).toContain('add Linear or Jira if your team plans work there')
    expect(markup).not.toContain('Use GitHub issues')
    // Keep dedicated trackers discoverable even when code-host issues already satisfy tasks.
    expect(markup).toContain('Add Linear access')
    expect(markup).toContain('Connect Jira')
  })

  it('offers GitHub and GitLab as task sources when review came from a non-task provider', async () => {
    installStore(
      makePreflightStatus({
        bitbucket: { configured: true, authenticated: true, account: 'acme' }
      })
    )

    const { markup } = await renderConnectIntegrationsList()

    expect(markup).toContain('issues also work as tasks.')
    expect(markup).toContain('gh auth login')
    expect(markup).toContain('glab auth login')
    expect(markup).toContain('Linear')
    expect(markup).toContain('Jira')
  })

  it('lists the code host alongside a connected tracker in the task summary', async () => {
    installStore(makePreflightStatus({ gh: { installed: true, authenticated: true } }))
    if (!storeState.current) {
      throw new Error('Store state was not installed')
    }
    storeState.current.linearStatus = { connected: true, workspaces: [] }

    const { markup } = await renderConnectIntegrationsList()

    expect(markup).toContain('Linear')
    expect(markup).toContain('GitHub')
    expect(markup).toContain('connected for tasks')
    expect(markup).toContain(' and ')
    expect(markup).not.toContain('Connect Jira')
  })
})
