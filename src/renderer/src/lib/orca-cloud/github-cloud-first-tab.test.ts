// @vitest-environment happy-dom
// PAIRED-HELD-ACTIVE (n39): after a GitHub-only Orca Cloud create (GH-CREATE-SHEET hand-off) whose
// agent isn't set up, the held placeholder is the workspace's one tab and it is in front, so its
// "Set up once" strip is what the person sees. The mirror's initial-terminal seeder must not add a
// plain shell over it; if the seeder got there first, the held tab is brought forward once, but
// never over a tab the person chose or another workspace.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import { setOrcaCloudAgentAccountsStateForTest } from './orca-cloud-agent-accounts-store'
import {
  cloudTabHoldKey,
  readCloudAgentHold,
  releaseCloudAgentHold
} from './cloud-agent-launch-hold'
import {
  beginWebRuntimeInitialTerminalBootstrap,
  endWebRuntimeInitialTerminalBootstrap,
  isWebRuntimeInitialTerminalBootstrapInFlight,
  resetWebRuntimeInitialTerminalBootstrapForTests
} from '@/runtime/web-session-tabs-sync/initial-terminal/web-runtime-initial-terminal-bootstrap'

const host = vi.hoisted(() => {
  const value: {
    creates: { launchAgent?: string; environmentId: string | null; activate?: boolean }[]
  } = { creates: [] }
  return value
})

/** The mirror publishing a host tab (activated unless the create said not to). */
function mirrorTab(tabId: string, activate: boolean): void {
  const state = useAppStore.getState()
  const tabs = [...(state.tabsByWorktree['wt-1'] ?? []), { id: tabId, worktreeId: 'wt-1' }]
  useAppStore.setState({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the code under test reads only tab ids
    tabsByWorktree: { ...state.tabsByWorktree, 'wt-1': tabs } as never,
    ...(activate && state.activeWorktreeId === 'wt-1' ? { activeTabId: tabId } : {})
  })
}

vi.mock('@/components/cloud-workspaces/open-cloud-workspace', () => ({
  openCloudWorkspace: async () => ({ ok: true, worktreeId: 'wt-1', hostId: 'runtime:env-paired' }),
  firstWorktreeOnHost: () => 'wt-1'
}))
vi.mock('@/runtime/web-session-tabs-sync/actions/web-runtime-session-tab-lifecycle', () => ({
  closeWebRuntimeSessionTab: async () => 'applied'
}))
vi.mock('@/runtime/hosted-terminals/placement/web-session-terminal-placement', () => ({
  webTerminalPlacementParentTabId: (id: string) => id
}))
vi.mock('@/components/agent-tab-launch-context', () => ({
  captureAgentTabLaunchContext: () => ({})
}))
// The new-tab launch on a paired web host is one host terminal create through the account hold.
vi.mock('@/lib/agent-session/launch/new-tab/launch-agent-in-new-tab', async () => {
  const { createWithCloudAgentHold } = await import('./cloud-web-host-launch-hold')
  return {
    launchAgentInNewTabWithOutcome: (args: { agent: TuiAgent; worktreeId: string }) => {
      void createWithCloudAgentHold(
        { worktreeId: args.worktreeId, environmentId: 'env-paired', launchAgent: args.agent },
        async (create) => {
          host.creates.push(create)
          const hostTabId = `h${host.creates.length}`
          mirrorTab(toWebTerminalSurfaceTabId(hostTabId), create.activate !== false)
          return { outcome: { status: 'created' }, hostTabId }
        }
      )
    }
  }
})

const { startCloudWorkspaceFromGitHub } = await import('./start-cloud-workspace-from-github')
const { toWebTerminalSurfaceTabId } =
  await import('../../../../shared/workspace-layout/terminal-surface-id')

beforeEach(() => {
  host.creates = []
  resetWebRuntimeInitialTerminalBootstrapForTests()
  localStorage.clear()
  setOrcaCloudAgentAccountsStateForTest({
    load: {
      kind: 'ready',
      status: {
        credentials: {
          claude: { state: 'none' },
          codex: { state: 'none' },
          providerEnabled: { claude: true, codex: true }
        },
        sources: { defaults: {}, coveredByKey: { claude: false, codex: false } }
      }
    },
    setups: { claude: { phase: 'idle' }, codex: { phase: 'idle' } },
    keyKinds: { claude: null, codex: null },
    queue: { agents: [], index: 0 }
  })
  // The fresh pairing is in the catalog without its orcaCloudPaired flag yet; main knows it.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the checks read only id, name and source
  const runtimeEnvironments = [
    { id: 'env-paired', name: 'web (cloud)', source: 'manual' }
  ] as unknown as ReturnType<typeof useAppStore.getState>['runtimeEnvironments']
  useAppStore.setState({
    pendingWorktreeCreations: {},
    runtimeEnvironments,
    activeWorktreeId: 'wt-1',
    activeTabId: null,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the code under test reads only tab ids
    tabsByWorktree: {} as never
  })
  Object.assign(window, {
    api: {
      ...window.api,
      orcaCloudWorkspace: {
        createFromGitHub: async () => ({ ok: true, value: { sandboxId: 'sbx_1' } })
      },
      cloudWorkspaces: { get: async (id: string) => ({ ok: true, value: { id } }) },
      ephemeralVm: { onProvisionEvent: () => () => undefined },
      orcaCloudAgents: {
        isCloudEnvironment: async ({ runtimeEnvironmentId }: { runtimeEnvironmentId: string }) =>
          runtimeEnvironmentId === 'env-paired'
      }
    }
  })
})

const create = () =>
  startCloudWorkspaceFromGitHub({
    repoUrl: 'https://github.com/acme/web',
    fullName: 'acme/web',
    prompt: '',
    agent: 'claude'
  })
const HELD = () => toWebTerminalSurfaceTabId('h1')
const tabIds = () => (useAppStore.getState().tabsByWorktree['wt-1'] ?? []).map((tab) => tab.id)
/** The seeder's plain shell landing late, activated (what hid the strip on n39). */
function seederShellLands(): void {
  mirrorTab('web-terminal-seeded-shell', true)
  endWebRuntimeInitialTerminalBootstrap('env-paired', 'wt-1')
}

describe('PAIRED-HELD-ACTIVE: the held placeholder is in front after a GitHub-only create', () => {
  it('exactly one tab, the held placeholder, active; the seeder is held off meanwhile', async () => {
    await expect(create()).resolves.toBe(true)
    // While the agent's launch is on its way, the seeder can't claim the first terminal.
    expect(isWebRuntimeInitialTerminalBootstrapInFlight('env-paired', 'wt-1')).toBe(true)
    await vi.waitFor(() => expect(readCloudAgentHold(cloudTabHoldKey(HELD()))).not.toBeNull())
    await vi.waitFor(() =>
      expect(isWebRuntimeInitialTerminalBootstrapInFlight('env-paired', 'wt-1')).toBe(false)
    )
    expect(tabIds()).toEqual([HELD()])
    const active = useAppStore.getState().activeTabId
    expect(active).toBe(HELD())
    // The strip resolves for the tab in front.
    expect(readCloudAgentHold(cloudTabHoldKey(active!))).toMatchObject({ reason: 'notSetUp' })
    releaseCloudAgentHold(cloudTabHoldKey(HELD()), 'cancel')
  })

  it('the seeder got there first: once its shell lands in front, the held tab is brought forward', async () => {
    beginWebRuntimeInitialTerminalBootstrap('env-paired', 'wt-1')
    await create()
    await vi.waitFor(() => expect(tabIds()).toEqual([HELD()]))
    seederShellLands()
    await vi.waitFor(() => expect(useAppStore.getState().activeTabId).toBe(HELD()))
    releaseCloudAgentHold(cloudTabHoldKey(HELD()), 'cancel')
  })

  it('never steals focus from a tab the person is on in that workspace', async () => {
    mirrorTab('web-terminal-mine', true)
    beginWebRuntimeInitialTerminalBootstrap('env-paired', 'wt-1')
    await create()
    await vi.waitFor(() => expect(tabIds()).toContain(HELD()))
    // Fake time from here: the settle's recheck after the seeder's shell runs on a timer.
    vi.useFakeTimers()
    try {
      mirrorTab('web-terminal-seeded-shell', false)
      useAppStore.setState({ activeTabId: 'web-terminal-mine' })
      endWebRuntimeInitialTerminalBootstrap('env-paired', 'wt-1')
      await vi.advanceTimersByTimeAsync(600)
    } finally {
      vi.useRealTimers()
    }
    expect(useAppStore.getState().activeTabId).toBe('web-terminal-mine')
    releaseCloudAgentHold(cloudTabHoldKey(HELD()), 'cancel')
  })

  it('never steals focus from another workspace', async () => {
    beginWebRuntimeInitialTerminalBootstrap('env-paired', 'wt-1')
    await create()
    await vi.waitFor(() => expect(tabIds()).toEqual([HELD()]))
    useAppStore.setState({ activeWorktreeId: 'wt-2', activeTabId: 'web-terminal-elsewhere' })
    // The store's setActiveTab already ignores a tab outside the active workspace, so the end state
    // alone can't show the guard: it must not even ask to activate the held tab.
    const realSetActiveTab = useAppStore.getState().setActiveTab
    const setActiveTab = vi.fn(realSetActiveTab)
    useAppStore.setState({ setActiveTab })
    // Fake time from here: the settle's recheck after the seeder's shell runs on a timer.
    vi.useFakeTimers()
    try {
      seederShellLands()
      await vi.advanceTimersByTimeAsync(600)
    } finally {
      vi.useRealTimers()
      useAppStore.setState({ setActiveTab: realSetActiveTab })
    }
    expect(setActiveTab).not.toHaveBeenCalled()
    expect(useAppStore.getState()).toMatchObject({
      activeWorktreeId: 'wt-2',
      activeTabId: 'web-terminal-elsewhere'
    })
    releaseCloudAgentHold(cloudTabHoldKey(HELD()), 'cancel')
  })
})
