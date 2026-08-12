import { expect, test } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

const PANE_COUNT = 300
const STATUS_ROUNDS = 4
const BASE_TIME = 1_700_000_000_000

type BurstPane = {
  paneKey: string
  tabId: string
  terminalHandle: string
  worktreeId: string
}

type BurstEvidence = {
  statusPublications: number
  statusPublicationsAtVisible: number
  finalStates: string[]
  firstHistory: string[]
}

test('keeps the visible Agent Dashboard interactive during an ordered status burst', async ({
  electronApp,
  orcaPage
}) => {
  await waitForSessionReady(orcaPage)
  const worktreeId = await waitForActiveWorktree(orcaPage)
  const panes = await orcaPage.evaluate(
    ({ baseTime, paneCount, worktreeId }): BurstPane[] => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is unavailable')
      }
      const state = store.getState()
      const tab =
        state.tabsByWorktree[worktreeId]?.[0] ??
        state.createTab(worktreeId, undefined, undefined, {
          activate: false,
          id: 'agent-dashboard-burst-tab'
        })
      store.setState({
        agentDashboardDrawerOpen: false,
        settings: {
          ...store.getState().settings,
          experimentalAgentDashboardPopout: true,
          experimentalAgentDashboardMode: 'drawer',
          experimentalAgentDashboardShowIdle: true,
          tabAutoGenerateTitle: false
        }
      })
      const seeded: BurstPane[] = []
      for (let index = 0; index < paneCount; index += 1) {
        const leafId = `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
        const paneKey = `${tab.id}:${leafId}`
        const terminalHandle = `agent-dashboard-burst-${index}`
        store
          .getState()
          .setAgentStatus(
            paneKey,
            { state: 'working', prompt: `Baseline task ${index}`, agentType: 'codex' },
            'Codex',
            { updatedAt: baseTime - 1, stateStartedAt: baseTime - 1 },
            { tabId: tab.id, terminalHandle, worktreeId }
          )
        seeded.push({ paneKey, tabId: tab.id, terminalHandle, worktreeId })
      }
      const probe = { statusPublications: 0 }
      ;(window as typeof window & { __agentDashboardBurstProbe?: typeof probe })[
        '__agentDashboardBurstProbe'
      ] = probe
      store.subscribe((next, previous) => {
        if (next.agentStatusByPaneKey !== previous.agentStatusByPaneKey) {
          probe.statusPublications += 1
        }
      })
      return seeded
    },
    { baseTime: BASE_TIME, paneCount: PANE_COUNT, worktreeId }
  )

  const dashboardButton = orcaPage.getByRole('button', { name: /Agent Dashboard/ })
  await expect(dashboardButton).toBeVisible()

  await electronApp.evaluate(
    ({ BrowserWindow }, { baseTime, panes, statusRounds }) => {
      const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed())
      if (!window) {
        throw new Error('Orca BrowserWindow is unavailable')
      }
      for (let round = 0; round < statusRounds; round += 1) {
        for (const [index, pane] of panes.entries()) {
          const turn = round * panes.length + index
          const receivedAt = baseTime + turn * 3
          window.webContents.send('agentStatus:set', {
            ...pane,
            state: 'working',
            prompt: `Turn ${turn}`,
            agentType: 'codex',
            receivedAt,
            stateStartedAt: receivedAt
          })
          window.webContents.send('agentStatus:set', {
            ...pane,
            state: 'waiting',
            prompt: `Turn ${turn}`,
            agentType: 'codex',
            receivedAt: receivedAt + 1,
            stateStartedAt: receivedAt + 1
          })
          window.webContents.send('agentStatus:set', {
            ...pane,
            state: 'done',
            prompt: `Turn ${turn}`,
            agentType: 'codex',
            lastAssistantMessage: `Completed ${turn}`,
            receivedAt: receivedAt + 2,
            stateStartedAt: receivedAt + 2
          })
        }
      }
    },
    { baseTime: BASE_TIME, panes, statusRounds: STATUS_ROUNDS }
  )

  const interactionStartedAt = performance.now()
  await dashboardButton.click()
  await orcaPage.locator('[data-agent-dashboard-sheet]').waitFor({ state: 'visible' })
  const interactionElapsedMs = performance.now() - interactionStartedAt
  const statusPublicationsAtVisible = await orcaPage.evaluate(() => {
    const probe = (
      window as typeof window & { __agentDashboardBurstProbe?: { statusPublications: number } }
    ).__agentDashboardBurstProbe
    if (!probe) {
      throw new Error('Agent Dashboard burst evidence is unavailable')
    }
    return probe.statusPublications
  })

  await expect
    .poll(
      () =>
        orcaPage.evaluate(
          (paneKeys) => {
            const statuses = window.__store?.getState().agentStatusByPaneKey ?? {}
            return paneKeys.every((paneKey) => statuses[paneKey]?.state === 'done')
          },
          panes.map(({ paneKey }) => paneKey)
        ),
      { timeout: 30_000 }
    )
    .toBe(true)

  const evidence = await orcaPage.evaluate(
    ({ paneKeys, statusPublicationsAtVisible }): BurstEvidence => {
      const state = window.__store?.getState()
      const probe = (
        window as typeof window & { __agentDashboardBurstProbe?: { statusPublications: number } }
      ).__agentDashboardBurstProbe
      if (!state || !probe) {
        throw new Error('Agent Dashboard burst evidence is unavailable')
      }
      const first = state.agentStatusByPaneKey[paneKeys[0]]
      return {
        statusPublications: probe.statusPublications,
        statusPublicationsAtVisible,
        finalStates: paneKeys.map(
          (paneKey) => state.agentStatusByPaneKey[paneKey]?.state ?? 'missing'
        ),
        firstHistory: first?.stateHistory.map(({ state: historyState }) => historyState) ?? []
      }
    },
    { paneKeys: panes.map(({ paneKey }) => paneKey), statusPublicationsAtVisible }
  )

  console.log(
    JSON.stringify({
      sha: process.env.GITHUB_SHA ?? 'local',
      paneCount: PANE_COUNT,
      statusRounds: STATUS_ROUNDS,
      ipcEvents: PANE_COUNT * STATUS_ROUNDS * 3,
      interactionElapsedMs: Math.round(interactionElapsedMs * 10) / 10,
      statusPublications: evidence.statusPublications,
      statusPublicationsAtVisible: evidence.statusPublicationsAtVisible,
      firstHistory: evidence.firstHistory
    })
  )

  expect(evidence.statusPublicationsAtVisible).toBeLessThanOrEqual(3)
  expect(evidence.statusPublications).toBeLessThanOrEqual(3)
  expect(new Set(evidence.finalStates)).toEqual(new Set(['done']))
  expect(evidence.firstHistory.slice(-2)).toEqual(['working', 'waiting'])
})
