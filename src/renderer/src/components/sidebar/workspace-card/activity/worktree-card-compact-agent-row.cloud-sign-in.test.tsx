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

/** `true`: only SessionStart has reported. `false`: a turn ran and ended (history and turn end). */
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
      stateHistory: sessionBoundary ? [] : [{ state: 'working', prompt: '', startedAt: 600 }],
      ...(sessionBoundary ? {} : { turnEndedAt: 1000 }),
      sessionBoundary,
      paneKey: 'tab-1:leaf-1',
      updatedAt: 1000
    }
  }
}

/** The row a real cloud workspace mirrors from its host (m4air "crayfish"): no sessionBoundary. */
function makeMirroredAgent(worktreeId: string): DashboardAgentRowData {
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
      agentType: 'claude',
      launchAttested: true,
      mirroredEvidenceReceivedAt: 1500,
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

function renderRow(agent: DashboardAgentRowData, onActivate = () => {}): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(
      <TooltipProvider>
        <CompactAgentRow agent={agent} now={2000} onActivate={onActivate} />
      </TooltipProvider>
    )
  })
  return container
}

describe('CompactAgentRow on an Orca Cloud workspace whose agent is not signed in', () => {
  it('shows Needs sign-in instead of Done when Claude is not set up', () => {
    const container = renderRow(makeAgent(CLOUD_WORKTREE, true))
    expect(container.textContent).toContain('Needs sign-in - Claude')
    expect(container.textContent).not.toContain('Done')
  })

  it('shows Sign-in expired when the Orca account sign-in expired', () => {
    setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'expired' }))
    const container = renderRow(makeAgent(CLOUD_WORKTREE, true))
    expect(container.textContent).toContain('Sign-in expired - Claude')
  })

  it('trusts the sandbox report: signedOut shows Needs sign-in even when the account covers it', () => {
    setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'active' }))
    rememberHostAgentSignInReport(CLOUD_ENV, {
      checkedAt: 1,
      agents: [{ agent: 'claude', state: 'signedOut' }]
    })
    const container = renderRow(makeAgent(CLOUD_WORKTREE, true))
    expect(container.textContent).toContain('Needs sign-in - Claude')
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
    expect(container.textContent).not.toContain('Needs sign-in')
  })

  it('shows Needs sign-in for the row mirrored from the cloud host (no sessionBoundary)', () => {
    const container = renderRow(makeMirroredAgent(CLOUD_WORKTREE))
    expect(container.textContent).toContain('Needs sign-in - Claude')
    expect(container.textContent).not.toContain('Done')
  })

  it('keeps Done for a mirrored row with a finished turn', () => {
    const mirrored = makeMirroredAgent(CLOUD_WORKTREE)
    const container = renderRow({
      ...mirrored,
      entry: {
        ...mirrored.entry,
        stateHistory: [{ state: 'working', prompt: '', startedAt: 600 }],
        turnEndedAt: 1000
      }
    })
    expect(container.textContent).toContain('Done - Claude')
  })

  it('keeps Done for a mirrored row once the prompt ran', () => {
    const mirrored = makeMirroredAgent(CLOUD_WORKTREE)
    const container = renderRow({
      ...mirrored,
      entry: { ...mirrored.entry, prompt: 'Fix the login redirect' }
    })
    expect(container.textContent).not.toContain('Needs sign-in')
  })

  it('leaves the same mirrored shape on a local workspace unchanged', () => {
    const container = renderRow(makeMirroredAgent(LOCAL_WORKTREE))
    expect(container.textContent).toContain('Done - Claude')
  })
})

function renderFullRow(agent: DashboardAgentRowData, onActivate = () => {}): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(
      <TooltipProvider>
        <DashboardAgentRow agent={agent} now={2000} onActivate={onActivate} onDismiss={() => {}} />
      </TooltipProvider>
    )
  })
  return container
}

function fullRowLabel(container: HTMLElement): string | null {
  return container.querySelector('span.flex-1')?.textContent ?? null
}

describe('DashboardAgentRow (full row) on an Orca Cloud workspace', () => {
  it('shows Needs sign-in instead of Done when Claude is not set up', () => {
    const container = renderFullRow(makeAgent(CLOUD_WORKTREE, true))
    expect(fullRowLabel(container)).toBe('Needs sign-in')
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

  it('shows Needs sign-in for the row mirrored from the cloud host', () => {
    expect(fullRowLabel(renderFullRow(makeMirroredAgent(CLOUD_WORKTREE)))).toBe('Needs sign-in')
  })

  it('leaves a local workspace unchanged', () => {
    const container = renderFullRow(makeAgent(LOCAL_WORKTREE, true))
    expect(fullRowLabel(container)).toBe('Done')
    expect(container.textContent).not.toContain('Needs sign-in')
    expect(container.querySelector('button[title*="Agent accounts"]')).toBeNull()
  })
})

function click(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe.each([
  ['compact', renderRow],
  ['full', renderFullRow]
] as const)('%s row: the sign-in status links to Settings → Agent accounts', (_name, render) => {
  beforeEach(() => {
    useAppStore.setState({ activeView: 'terminal', settingsNavigationTarget: null })
  })

  it('names where to set up, and clicking the status opens Agent accounts, not the pane', () => {
    const onActivate = vi.fn()
    const container = render(makeAgent(CLOUD_WORKTREE, true), onActivate)
    const text = container.querySelector('button[title]')
    expect(text?.getAttribute('title')).toBe('Set up once in Settings → Agent accounts')
    expect(text?.textContent).toBe('Needs sign-in')
    click(text!)
    expect(onActivate).not.toHaveBeenCalled()
    expect(useAppStore.getState().activeView).toBe('settings')
    expect(useAppStore.getState().settingsNavigationTarget).toMatchObject({
      pane: 'agent-accounts',
      sectionId: 'orca-cloud'
    })
  })

  it('opens Agent accounts from the dot too', () => {
    const onActivate = vi.fn()
    const container = render(makeAgent(CLOUD_WORKTREE, true), onActivate)
    const dot = container.querySelector('button:not([title])')
    expect(dot).not.toBeNull()
    click(dot!)
    expect(onActivate).not.toHaveBeenCalled()
    expect(useAppStore.getState().activeView).toBe('settings')
  })

  it('tells an expired sign-in to renew', () => {
    setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'expired' }))
    const container = render(makeAgent(CLOUD_WORKTREE, true))
    expect(container.querySelector('button[title]')?.getAttribute('title')).toBe(
      'Renew in Settings → Agent accounts'
    )
  })

  it('still activates the pane when the rest of the row is clicked', () => {
    const onActivate = vi.fn()
    const container = render(makeAgent(CLOUD_WORKTREE, true), onActivate)
    click(container.firstElementChild!)
    expect(onActivate).toHaveBeenCalledWith('tab-1', 'tab-1:leaf-1')
    expect(useAppStore.getState().activeView).toBe('terminal')
  })
})
