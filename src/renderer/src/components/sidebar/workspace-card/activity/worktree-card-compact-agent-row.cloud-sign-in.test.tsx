/** @vitest-environment happy-dom */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DashboardAgentRow as DashboardAgentRowData } from '@/components/dashboard/useDashboardData'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import type { OrcaCloudAgentsStatus } from '../../../../../../shared/orca-cloud-agents/orca-cloud-agents-wire'
import {
  setOrcaCloudAgentAccountsStateForTest,
  type OrcaCloudAgentAccountsState
} from '@/lib/orca-cloud/orca-cloud-agent-accounts-store'
import {
  _resetHostAgentSignInReportsForTest,
  rememberHostAgentSignInReport
} from '@/runtime/provider-accounts/sign-in/host-agent-sign-in-status-client'
import type * as HostAgentSignInClient from '@/runtime/provider-accounts/sign-in/host-agent-sign-in-status-client'
import type { PublicKnownRuntimeEnvironment } from '../../../../../../shared/remote-runtime/host-catalog/runtime-environments'
import { makeTabWithIds } from '@/components/activity/ActivityPrototypePage-test-fixtures'
import DashboardAgentRow from '@/components/dashboard/DashboardAgentRow'
import { CompactAgentRow } from './worktree-card-compact-agent-row'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const CLOUD_ENV = 'env-cloud'
const LOCAL_WORKTREE = 'wt-local'
const CLOUD_WORKTREE = 'wt-cloud'

vi.mock('@/components/dashboard/use-agent-row-conversation-name', () => ({
  useAgentRowConversationName: () => null
}))

vi.mock('./CacheTimer', () => ({
  default: () => null,
  usePromptCacheCountdownForPane: () => null
}))

vi.mock('@/store/github/refresh/worktree-refresh', () => ({
  findWorktreeById: (_state: unknown, worktreeId: string) =>
    worktreeId === CLOUD_WORKTREE || worktreeId === LOCAL_WORKTREE ? { id: worktreeId } : null
}))

vi.mock('@/lib/workspace/ownership/worktree-row-open-in-owner', () => ({
  resolveWorktreeRowOpenInRuntimeOwner: (_state: unknown, worktree: { id: string }) => ({
    runtimeEnvironmentId: worktree.id === CLOUD_WORKTREE ? CLOUD_ENV : null,
    connectionId: null,
    ownerUnresolved: false
  })
}))

vi.mock('@/runtime/provider-accounts/sign-in/host-agent-sign-in-status-client', async (load) => ({
  ...(await load<typeof HostAgentSignInClient>()),
  // No RPC in tests; reports come from rememberHostAgentSignInReport.
  precheckHostAgentSignIn: () => {}
}))

function accounts(
  claude: OrcaCloudAgentsStatus['credentials']['claude']
): OrcaCloudAgentAccountsState {
  return {
    load: {
      kind: 'ready',
      status: {
        credentials: {
          claude,
          codex: { state: 'none' },
          providerEnabled: { claude: true, codex: true }
        },
        sources: { defaults: {}, coveredByKey: { claude: false, codex: false } }
      }
    },
    setups: { claude: { phase: 'idle' }, codex: { phase: 'idle' } },
    keyKinds: { claude: null, codex: null },
    queue: { agents: [], index: 0 }
  }
}

function makeAgent(worktreeId: string, sessionBoundary: boolean): DashboardAgentRowData {
  return {
    paneKey: 'tab-1:leaf-1',
    tab: makeTabWithIds('tab-1', worktreeId),
    agentType: 'claude',
    state: 'done',
    startedAt: 500,
    entry: {
      prompt: '',
      state: 'done',
      stateStartedAt: 1000,
      stateHistory: [],
      sessionBoundary,
      paneKey: 'tab-1:leaf-1',
      updatedAt: 1000
    }
  }
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the row reads only id, name and source.
const cloudEnvironment = {
  id: CLOUD_ENV,
  name: 'orca sandbox abcd1234',
  source: 'ephemeral-vm'
} as unknown as PublicKnownRuntimeEnvironment

let root: Root | undefined

beforeEach(() => {
  useAppStore.setState({ runtimeEnvironments: [cloudEnvironment] })
  setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'none' }))
})

afterEach(() => {
  act(() => root?.unmount())
  document.body.replaceChildren()
  _resetHostAgentSignInReportsForTest()
})

function renderRow(agent: DashboardAgentRowData): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(
      <TooltipProvider>
        <CompactAgentRow agent={agent} now={2000} onActivate={() => {}} />
      </TooltipProvider>
    )
  })
  return container
}

describe('CompactAgentRow on an Orca Cloud workspace whose agent is not signed in', () => {
  it('shows Not signed in instead of Done when Claude is not set up', () => {
    const container = renderRow(makeAgent(CLOUD_WORKTREE, true))
    expect(container.textContent).toContain('Not signed in - Claude')
    expect(container.textContent).not.toContain('Done')
  })

  it('shows Sign-in expired when the Orca account sign-in expired', () => {
    setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'expired' }))
    const container = renderRow(makeAgent(CLOUD_WORKTREE, true))
    expect(container.textContent).toContain('Sign-in expired - Claude')
  })

  it('trusts the sandbox report: signedOut shows Not signed in even when the account covers it', () => {
    setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'active' }))
    rememberHostAgentSignInReport(CLOUD_ENV, {
      checkedAt: 1,
      agents: [{ agent: 'claude', state: 'signedOut' }]
    })
    const container = renderRow(makeAgent(CLOUD_WORKTREE, true))
    expect(container.textContent).toContain('Not signed in - Claude')
  })

  it('keeps Done when the sandbox reports Claude signed in (a /login there)', () => {
    rememberHostAgentSignInReport(CLOUD_ENV, {
      checkedAt: 1,
      agents: [{ agent: 'claude', state: 'signedIn', method: 'cliLogin' }]
    })
    const container = renderRow(makeAgent(CLOUD_WORKTREE, true))
    expect(container.textContent).toContain('Done - Claude')
  })

  it('keeps Done for a covered agent idle after a turn', () => {
    setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'active' }))
    const container = renderRow(makeAgent(CLOUD_WORKTREE, false))
    expect(container.textContent).toContain('Done - Claude')
  })

  it('keeps Done after a finished turn even when the account is not set up', () => {
    const container = renderRow(makeAgent(CLOUD_WORKTREE, false))
    expect(container.textContent).toContain('Done - Claude')
  })

  it('leaves a local workspace unchanged', () => {
    const container = renderRow(makeAgent(LOCAL_WORKTREE, true))
    expect(container.textContent).toContain('Done - Claude')
    expect(container.textContent).not.toContain('Not signed in')
  })
})

function renderFullRow(agent: DashboardAgentRowData): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(
      <TooltipProvider>
        <DashboardAgentRow agent={agent} now={2000} onActivate={() => {}} onDismiss={() => {}} />
      </TooltipProvider>
    )
  })
  return container
}

function fullRowLabel(container: HTMLElement): string | null {
  return container.querySelector('span.flex-1[title]')?.textContent ?? null
}

describe('DashboardAgentRow (full row) on an Orca Cloud workspace', () => {
  it('shows Not signed in instead of Done when Claude is not set up', () => {
    const container = renderFullRow(makeAgent(CLOUD_WORKTREE, true))
    expect(fullRowLabel(container)).toBe('Not signed in')
    expect(container.querySelector('[aria-label="Needs attention"]')).not.toBeNull()
  })

  it('shows Sign-in expired when the Orca account sign-in expired', () => {
    setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'expired' }))
    expect(fullRowLabel(renderFullRow(makeAgent(CLOUD_WORKTREE, true)))).toBe('Sign-in expired')
  })

  it('keeps Done for a covered agent idle after a turn', () => {
    setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'active' }))
    expect(fullRowLabel(renderFullRow(makeAgent(CLOUD_WORKTREE, false)))).toBe('Done')
  })

  it('leaves a local workspace unchanged', () => {
    const container = renderFullRow(makeAgent(LOCAL_WORKTREE, true))
    expect(fullRowLabel(container)).toBe('Done')
    expect(container.textContent).not.toContain('Not signed in')
  })
})
