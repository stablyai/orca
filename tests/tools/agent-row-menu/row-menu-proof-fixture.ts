import {
  expect,
  type ElectronApplication,
  type Page,
  type TestInfo
} from '@stablyai/playwright-test'
import { test as electronTest } from '../../e2e/desktop/electron-fixtures/orca-app'
import { structuredAgentSessionPaneKey } from '../../../src/shared/agent-session/view/structured-agent-session-projection'
import {
  toRuntimeExecutionHostId,
  toSshExecutionHostId
} from '../../../src/shared/execution-host/execution-host'
import { observeProofRuntime } from './proof-loaded-inputs'
import { captureProofCalls } from './row-menu-proof-ipc'

const fixture = {
  chatTabId: 'proof-agent-row-chat',
  chatSessionId: '77777777-7777-4777-8777-777777777777',
  providerSessionId: '88888888-8888-4888-8888-888888888888',
  replacementChatId: '66666666-6666-4666-8666-666666666666',
  forkSessionId: '11111111-1111-4111-8111-111111111111',
  workerTabId: 'web-terminal-proof-agent-row-worker',
  workerLeafId: '99999999-9999-4999-8999-999999999999',
  environment: {
    id: 'proof-paired-host',
    name: 'Paired proof host',
    createdAt: 1,
    updatedAt: 1,
    pairingRevision: 7,
    lastUsedAt: 1,
    runtimeId: 'proof-paired-runtime',
    pairedDeviceId: 'proof-device',
    endpoints: [
      {
        id: 'proof-endpoint',
        kind: 'websocket' as const,
        label: 'WebSocket',
        endpoint: 'ws://127.0.0.1:9'
      }
    ],
    preferredEndpointId: 'proof-endpoint',
    hostKeyFingerprint: 'proof-host-key'
  }
}

const hostId = toRuntimeExecutionHostId(fixture.environment.id)
const sshConnectionId = 'proof-detected-ssh'
const sshHostId = toSshExecutionHostId(sshConnectionId)
export const workerPaneKey = `${fixture.workerTabId}:${fixture.workerLeafId}`

async function setupRowMenuProof(
  page: Page,
  electronApp: ElectronApplication,
  seededRepoPath: string,
  registerPostElectronShutdownCleanup: (cleanup: () => Promise<void>) => void,
  testInfo: TestInfo
) {
  const runtime = await observeProofRuntime(
    page,
    electronApp,
    registerPostElectronShutdownCleanup,
    testInfo
  )
  const { workspaceId, otherWorkspaceId, repoId } = await page.evaluate((repoPath) => {
    const store = window.__store!
    const state = store.getState()
    const repo = state.repos.find((candidate) => candidate.path === repoPath)!
    const worktrees = state.worktreesByRepo[repo.id]!
    const main = worktrees.find((worktree) => worktree.isMainWorktree)!
    const other = worktrees.find((worktree) => worktree.id !== main.id)!
    state.setSidebarWidth(276)
    state.setAgentActivityDisplayMode('full')
    store.setState({
      worktreesByRepo: {
        ...state.worktreesByRepo,
        [repo.id]: worktrees.map((worktree) =>
          worktree.id === main.id ? { ...worktree, hostId: 'local' } : worktree
        )
      }
    })
    if (state.settings) {
      store.setState({
        settings: {
          ...state.settings,
          uiLanguage: 'en',
          agentCmdOverrides: { ...state.settings.agentCmdOverrides, codex: 'echo' }
        }
      })
    }
    return { workspaceId: main.id, otherWorkspaceId: other.id, repoId: repo.id }
  }, seededRepoPath)
  const { calls, preparations } = await captureProofCalls(electronApp, {
    workspaceId,
    repoPath: seededRepoPath,
    forkSessionId: fixture.forkSessionId,
    environmentId: fixture.environment.id
  })
  const snapshot = (name: string) => page.screenshot({ path: testInfo.outputPath(`${name}.png`) })
  const sidebar = page.locator('[data-worktree-sidebar]')
  const menu = page.getByRole('menu', { name: /^Agent: / })
  const item = (name: string) => menu.getByRole('menuitem', { name, exact: true })
  const gone = page.getByText('This agent is no longer open.', { exact: true })
  const openMenu = async (paneKey: string) => {
    await sidebar
      .locator(`[data-agent-row-pane-key="${paneKey}"]`)
      .first()
      .click({ button: 'right' })
    await expect(menu).toBeVisible()
  }
  const activateOtherWorkspace = () =>
    page.evaluate((id) => {
      window.__store!.getState().setActiveWorktree(id, 'local')
    }, otherWorkspaceId)
  const activeWorkspace = () => page.evaluate(() => window.__store!.getState().activeWorktreeId)
  const renderedActiveTab = (id: string) =>
    page.locator(`[data-testid="sortable-tab"][data-tab-id="${id}"][data-active="true"]`)
  const chatPaneKey = structuredAgentSessionPaneKey(fixture.chatTabId, fixture.chatSessionId)
  const seedChat = () =>
    page.evaluate(
      ({ workspaceId, chatPaneKey, fixture }) => {
        const store = window.__store!
        const state = store.getState()
        state.createUnifiedTab(workspaceId, 'agent-session', {
          id: fixture.chatTabId,
          entityId: fixture.chatSessionId,
          label: 'Proof planning chat',
          agentSessionAgent: 'codex',
          executionHostId: 'local',
          activate: false
        })
        state.setAgentStatus(
          chatPaneKey,
          {
            state: 'working',
            agentType: 'codex',
            prompt: 'Plan the sample work'
          },
          'Proof planning chat',
          undefined,
          { tabId: fixture.chatTabId, worktreeId: workspaceId }
        )
      },
      { workspaceId, chatPaneKey, fixture }
    )
  const replaceChatEntity = (entityId: string) =>
    page.evaluate(
      ({ workspaceId, tabId, entityId }) => {
        const store = window.__store!
        store.setState((state) => ({
          unifiedTabsByWorktree: {
            ...state.unifiedTabsByWorktree,
            [workspaceId]: state.unifiedTabsByWorktree[workspaceId]!.map((tab) =>
              tab.id === tabId ? { ...tab, entityId } : tab
            )
          }
        }))
      },
      { workspaceId, tabId: fixture.chatTabId, entityId }
    )
  const addPairedTwin = () =>
    page.evaluate(
      ({ workspaceId, repoId, hostId, environment }) => {
        const store = window.__store!
        store.getState().setRuntimeEnvironments([environment])
        store.setState((state) => {
          const worktrees = state.worktreesByRepo[repoId]!
          const local = worktrees.find((worktree) => worktree.id === workspaceId)!
          return {
            worktreesByRepo: {
              ...state.worktreesByRepo,
              [repoId]: [
                ...worktrees,
                {
                  ...local,
                  hostId,
                  runtimeOwnerEnvironmentId: environment.id,
                  displayName: 'Paired proof workspace'
                }
              ]
            }
          }
        })
      },
      { workspaceId, repoId, hostId, environment: fixture.environment }
    )

  const addDetectedSshRival = (stamp: 'local' | undefined) =>
    page.evaluate(
      ({ workspaceId, repoId, sshConnectionId, sshHostId, stamp }) => {
        const store = window.__store!
        store.setState((state) => {
          const repo = state.repos.find((candidate) => candidate.id === repoId)!
          const worktrees = state.worktreesByRepo[repoId]!
          const local = worktrees.find((worktree) => worktree.id === workspaceId)!
          const detected = state.detectedWorktreesByRepo[repoId]?.worktrees ?? []
          // Construct the retained mixed catalog without publishing an SSH checkout.
          return {
            repos: [
              ...state.repos.filter((candidate) => candidate.id !== repoId),
              { ...repo, executionHostId: 'local' },
              { ...repo, executionHostId: sshHostId, connectionId: sshConnectionId }
            ],
            worktreesByRepo: {
              ...state.worktreesByRepo,
              [repoId]: worktrees.map((worktree) =>
                worktree.id === workspaceId ? { ...worktree, hostId: stamp } : worktree
              )
            },
            detectedWorktreesByRepo: {
              ...state.detectedWorktreesByRepo,
              [repoId]: {
                repoId,
                authoritative: true,
                source: 'git',
                worktrees: [
                  ...detected.filter((worktree) => worktree.id !== workspaceId),
                  {
                    ...local,
                    hostId: sshHostId,
                    ownership: 'external',
                    selectedCheckout: false,
                    visible: false
                  }
                ]
              }
            }
          }
        })
      },
      { workspaceId, repoId, sshConnectionId, sshHostId, stamp }
    )

  return {
    page,
    workspaceId,
    otherWorkspaceId,
    calls,
    snapshot,
    menu,
    item,
    gone,
    openMenu,
    activateOtherWorkspace,
    activeWorkspace,
    renderedActiveTab,
    chatPaneKey,
    seedChat,
    replaceChatEntity,
    addPairedTwin,
    addDetectedSshRival,
    preparations,
    ...runtime
  }
}

export const test = electronTest.extend<{ proof: Awaited<ReturnType<typeof setupRowMenuProof>> }>({
  proof: async (
    { orcaPage, electronApp, seededRepoPath, registerPostElectronShutdownCleanup },
    provideFixture,
    testInfo
  ) => {
    const proof = await setupRowMenuProof(
      orcaPage,
      electronApp,
      seededRepoPath,
      registerPostElectronShutdownCleanup,
      testInfo
    )
    try {
      await provideFixture(proof)
    } finally {
      await proof.detach()
    }
  }
})

export { fixture as rowMenuFixture }
