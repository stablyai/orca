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
import {
  closeOrcaCloudSignInSheet,
  isOrcaCloudSignInSheetOpen
} from '@/components/settings/agent-accounts/sign-in-sheet/orca-cloud-sign-in-sheet-store'
import { _resetCloudAgentAccountActiveSinceForTest } from '@/lib/orca-cloud/cloud-agent-account-active-since'
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

/**
 * The row leatherback showed 30 s after a restart ("Claude Code - Idle", grey dot, "now"): the
 * title-derived fallback row (worktree-title-derived-agent-rows), built when no hook entry is
 * live. Its prompt is the title label and its message the translated "Idle".
 */
function makeTitleDerivedAgent(worktreeId: string): DashboardAgentRowData {
  return {
    paneKey: 'tab-1:leaf-1',
    tab: makeTabWithIds('tab-1', worktreeId),
    agentType: 'claude',
    rowSource: 'live',
    state: 'idle',
    startedAt: 0,
    entry: {
      paneKey: 'tab-1:leaf-1',
      state: 'working',
      prompt: 'Claude Code',
      updatedAt: 2000,
      stateStartedAt: 2000,
      stateHistory: [],
      agentType: 'claude',
      terminalTitle: '✳ Claude Code',
      lastAssistantMessage: 'Idle',
      observation: {
        origin: 'title',
        authorityId: 'title-derived',
        incarnation: 0,
        revision: 2000,
        observedAt: 2000,
        kind: 'snapshot'
      }
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
  _resetCloudAgentAccountActiveSinceForTest()
})

function renderRow(agent: DashboardAgentRowData, onActivate = () => {}): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  rerenderRow(agent, onActivate)
  return container
}

function rerenderRow(agent: DashboardAgentRowData, onActivate = () => {}): void {
  act(() => {
    root!.render(
      <TooltipProvider>
        <CompactAgentRow agent={agent} now={2000} onActivate={onActivate} />
      </TooltipProvider>
    )
  })
}

function signedIn(method: 'apiKey' | 'cliLogin' | 'orcaAccount'): void {
  rememberHostAgentSignInReport(CLOUD_ENV, {
    checkedAt: 1,
    agents: [{ agent: 'claude', state: 'signedIn', method }]
  })
}

function signedOut(): void {
  rememberHostAgentSignInReport(CLOUD_ENV, {
    checkedAt: 1,
    agents: [{ agent: 'claude', state: 'signedOut' }]
  })
}

describe('CompactAgentRow on an Orca Cloud workspace: Agent accounts decide', () => {
  it('shows Needs sign-in instead of Done when Claude is not set up', () => {
    const container = renderRow(makeAgent(CLOUD_WORKTREE, true))
    expect(container.textContent).toContain('Needs sign-in - Claude')
    expect(container.textContent).not.toContain('Done')
  })

  it('shows Sign-in expired for an expired or revoked Orca account sign-in', () => {
    setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'expired' }))
    const container = renderRow(makeAgent(CLOUD_WORKTREE, true))
    expect(container.textContent).toContain('Sign-in expired - Claude')
    act(() => setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'revoked' })))
    expect(container.textContent).toContain('Sign-in expired - Claude')
  })

  it('wins over the title-derived idle row seen after a restart, and never says "Claude Code"', () => {
    setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'revoked' }))
    const container = renderRow(makeTitleDerivedAgent(CLOUD_WORKTREE))
    expect(container.textContent).toContain('Sign-in expired - Claude')
    expect(container.textContent).not.toContain('Claude Code')
    expect(container.textContent).not.toContain('Idle')
  })

  it('sticks across the row shapes that follow a restart', () => {
    setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'revoked' }))
    const container = renderRow(makeMirroredAgent(CLOUD_WORKTREE))
    expect(container.textContent).toContain('Sign-in expired - Claude')
    rerenderRow(makeTitleDerivedAgent(CLOUD_WORKTREE))
    expect(container.textContent).toContain('Sign-in expired - Claude')
    rerenderRow(makeAgent(CLOUD_WORKTREE, false))
    expect(container.textContent).toContain('Sign-in expired - Claude')
    rerenderRow({ ...makeMirroredAgent(CLOUD_WORKTREE), state: 'unverifiable' })
    expect(container.textContent).toContain('Sign-in expired - Claude')
  })

  it('wins over turn evidence while the account is not set up', () => {
    const container = renderRow(makeAgent(CLOUD_WORKTREE, false))
    expect(container.textContent).toContain('Needs sign-in - Claude')
  })

  it('is not cleared by the sandbox reporting the Orca-account placeholder as signed in', () => {
    setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'revoked' }))
    signedIn('apiKey')
    const container = renderRow(makeAgent(CLOUD_WORKTREE, true))
    expect(container.textContent).toContain('Sign-in expired - Claude')
  })

  it('is cleared by a sign-in made on the sandbox itself (/login there)', () => {
    signedIn('cliLogin')
    expect(renderRow(makeAgent(CLOUD_WORKTREE, true)).textContent).toContain('Done - Claude')
  })

  it('clears when the account becomes active', () => {
    setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'revoked' }))
    const container = renderRow(makeTitleDerivedAgent(CLOUD_WORKTREE))
    expect(container.textContent).toContain('Sign-in expired - Claude')
    act(() => setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'active' })))
    expect(container.textContent).toContain('Claude Code - Idle')
  })

  it('keeps Done for a covered agent idle after a turn', () => {
    setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'active' }))
    expect(renderRow(makeAgent(CLOUD_WORKTREE, false)).textContent).toContain('Done - Claude')
  })

  it('covered but the sandbox is signed out: needs sign-in until a turn ends after the account became active', () => {
    // A fixed clock: the account is first seen covered at 5000; the row's own turn ended at 1000.
    vi.useFakeTimers({ now: 5_000, toFake: ['Date'] })
    try {
      setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'active' }))
      signedOut()
      const container = renderRow(makeAgent(CLOUD_WORKTREE, false))
      expect(container.textContent).toContain('Needs sign-in - Claude')
      const finished = makeAgent(CLOUD_WORKTREE, false)
      rerenderRow({ ...finished, entry: { ...finished.entry, turnEndedAt: 6_000 } })
      expect(container.textContent).toContain('Done - Claude')
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves working rows alone', () => {
    setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'revoked' }))
    const working = makeAgent(CLOUD_WORKTREE, true)
    const container = renderRow({
      ...working,
      state: 'working',
      entry: { ...working.entry, state: 'working', prompt: 'Fix the login redirect' }
    })
    expect(container.textContent).not.toContain('Sign-in expired')
  })

  it('shows nothing extra while the Orca account path is paused (providerState disabled)', () => {
    const paused = accounts({ state: 'none' })
    if (paused.load.kind === 'ready') {
      paused.load.status.credentials.providerEnabled = { claude: false, codex: true }
      paused.load.status.credentials.providerState = { claude: 'disabled', codex: 'on' }
    }
    setOrcaCloudAgentAccountsStateForTest(paused)
    expect(renderRow(makeMirroredAgent(CLOUD_WORKTREE)).textContent).toContain('Done - Claude')
  })

  it('leaves a local workspace unchanged, whatever the row shape', () => {
    setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'revoked' }))
    const container = renderRow(makeAgent(LOCAL_WORKTREE, true))
    expect(container.textContent).toContain('Done - Claude')
    rerenderRow(makeTitleDerivedAgent(LOCAL_WORKTREE))
    expect(container.textContent).toContain('Claude Code - Idle')
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
  it('reads "Needs sign-in - Claude" when Claude is not set up', () => {
    const container = renderFullRow(makeAgent(CLOUD_WORKTREE, true))
    expect(fullRowLabel(container)).toBe('Needs sign-in - Claude')
    expect(container.querySelector('[aria-label="Needs attention"]')).not.toBeNull()
  })

  it('reads "Sign-in expired - Claude" over the title-derived idle row', () => {
    setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'revoked' }))
    const container = renderFullRow(makeTitleDerivedAgent(CLOUD_WORKTREE))
    expect(fullRowLabel(container)).toBe('Sign-in expired - Claude')
    expect(container.textContent).not.toContain('Claude Code')
    expect(container.textContent).not.toContain('Idle')
  })

  it('keeps Done for a covered agent idle after a turn', () => {
    setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'active' }))
    expect(fullRowLabel(renderFullRow(makeAgent(CLOUD_WORKTREE, false)))).toBe('Done')
  })

  it('leaves a local workspace unchanged', () => {
    const container = renderFullRow(makeAgent(LOCAL_WORKTREE, true))
    expect(fullRowLabel(container)).toBe('Done')
    expect(container.querySelector('[data-cloud-sign-in-status]')).toBeNull()
  })
})

describe('a row that renders before the Agent accounts read lands', () => {
  it('picks up the sign-in state once the accounts load (restored row)', () => {
    setOrcaCloudAgentAccountsStateForTest({
      ...accounts({ state: 'none' }),
      load: { kind: 'loading' }
    })
    const container = renderRow(makeTitleDerivedAgent(CLOUD_WORKTREE))
    expect(container.textContent).toContain('Claude Code - Idle')
    act(() => setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'revoked' })))
    expect(container.textContent).toContain('Sign-in expired - Claude')
  })

  it('picks it up once the cloud environment is known', () => {
    useAppStore.setState({ runtimeEnvironments: [] })
    const container = renderFullRow(makeMirroredAgent(CLOUD_WORKTREE))
    expect(fullRowLabel(container)).toBe('Done')
    act(() => useAppStore.setState({ runtimeEnvironments: [cloudEnvironment] }))
    expect(fullRowLabel(container)).toBe('Needs sign-in - Claude')
  })
})

function click(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function statusButtons(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('[data-cloud-sign-in-status]'))
}

/** Keyboard focus opens the app tooltip; read its content, not a title attribute. */
function focusTooltip(button: HTMLButtonElement): Element | null {
  act(() => button.focus())
  return document.body.querySelector('[role="tooltip"]')
}

describe.each([
  ['compact', renderRow],
  ['full', renderFullRow]
] as const)('%s row: the sign-in status opens the Orca Cloud sign-in sheet', (_name, render) => {
  beforeEach(() => {
    useAppStore.setState({ activeView: 'terminal', settingsNavigationTarget: null })
  })

  it('has a focusable dot and text, with no native title', () => {
    const [dot, text] = statusButtons(render(makeAgent(CLOUD_WORKTREE, true)))
    expect(dot.getAttribute('aria-label')).toBe('Needs sign-in - Claude')
    expect(text.textContent).toBe('Needs sign-in')
    expect(dot.hasAttribute('title') || text.hasAttribute('title')).toBe(false)
  })

  it('shows the app tooltip below and from the start on keyboard focus, clear of the name above', () => {
    const [, text] = statusButtons(render(makeAgent(CLOUD_WORKTREE, true)))
    expect(focusTooltip(text)?.textContent).toBe('Set up once for Orca Cloud')
    const content = document.body.querySelector('[data-side]')
    expect(content?.getAttribute('data-side')).toBe('bottom')
    expect(content?.getAttribute('data-align')).toBe('start')
  })

  it('shows the app tooltip on keyboard focus of the dot', () => {
    const [dot] = statusButtons(render(makeAgent(CLOUD_WORKTREE, true)))
    expect(focusTooltip(dot)?.textContent).toBe('Set up once for Orca Cloud')
  })

  it('tells an expired sign-in to renew', () => {
    setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'expired' }))
    const [, text] = statusButtons(render(makeAgent(CLOUD_WORKTREE, true)))
    expect(focusTooltip(text)?.textContent).toBe('Renew for Orca Cloud')
  })

  // JA-04 (#349): "Set up once" opens the focused "Agents in Orca Cloud" sheet, not Settings.
  it('clicking the text opens the Orca Cloud sign-in sheet (the composer\'s "Set up once" target), not the pane', () => {
    closeOrcaCloudSignInSheet()
    const onActivate = vi.fn()
    const [, text] = statusButtons(render(makeAgent(CLOUD_WORKTREE, true), onActivate))
    click(text)
    expect(onActivate).not.toHaveBeenCalled()
    expect(isOrcaCloudSignInSheetOpen()).toBe(true)
    expect(useAppStore.getState().activeView).toBe('terminal')
  })

  it('clicking the dot opens the sign-in sheet too', () => {
    closeOrcaCloudSignInSheet()
    const onActivate = vi.fn()
    const [dot] = statusButtons(render(makeAgent(CLOUD_WORKTREE, true), onActivate))
    click(dot)
    expect(onActivate).not.toHaveBeenCalled()
    expect(isOrcaCloudSignInSheetOpen()).toBe(true)
  })

  it('still activates the pane when the rest of the row is clicked', () => {
    const onActivate = vi.fn()
    const container = render(makeAgent(CLOUD_WORKTREE, true), onActivate)
    click(container.firstElementChild!)
    expect(onActivate).toHaveBeenCalledWith('tab-1', 'tab-1:leaf-1')
    expect(useAppStore.getState().activeView).toBe('terminal')
  })
})
