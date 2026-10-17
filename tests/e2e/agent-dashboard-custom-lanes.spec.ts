import { expect, test } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

const BASE_TIME = Date.now()

type SeededAgent = { paneKey: string; prompt: string }

test('parks Agent Dashboard cards in a user-defined lane', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  // Room for the status columns plus one lane, so the screenshots show the whole board.
  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((candidate) => !candidate.isDestroyed())
      ?.setSize(1680, 900)
  })
  await waitForSessionReady(orcaPage)
  const worktreeId = await waitForActiveWorktree(orcaPage)
  const agents = await orcaPage.evaluate(
    async ({ baseTime, worktreeId }): Promise<SeededAgent[]> => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is unavailable')
      }
      const state = store.getState()
      const tab =
        state.tabsByWorktree[worktreeId]?.[0] ??
        state.createTab(worktreeId, undefined, undefined, {
          activate: false,
          id: 'agent-dashboard-lanes-tab'
        })
      // Why: persisted through main, so later lane writes don't revert these.
      await state.updateSettings({
        experimentalAgentDashboardPopout: true,
        experimentalAgentDashboardMode: 'in-window',
        tabAutoGenerateTitle: false
      })
      const seeds = [
        { state: 'working', prompt: 'Refactor the billing webhooks' },
        { state: 'done', prompt: 'Open the PR and wait for CI' },
        { state: 'done', prompt: 'Summarize the customer interview' }
      ] as const
      return seeds.map((seed, index) => {
        const leafId = `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
        const paneKey = `${tab.id}:${leafId}`
        store.getState().setAgentStatus(
          paneKey,
          {
            state: seed.state,
            prompt: seed.prompt,
            agentType: 'claude',
            lastAssistantMessage: seed.state === 'done' ? 'Finished.' : undefined
          },
          'Claude',
          { updatedAt: baseTime + index, stateStartedAt: baseTime + index },
          { tabId: tab.id, terminalHandle: `agent-dashboard-lanes-${index}`, worktreeId }
        )
        return { paneKey, prompt: seed.prompt }
      })
    },
    { baseTime: BASE_TIME, worktreeId }
  )
  const parked = agents[1]

  await orcaPage.getByRole('button', { name: /Agent Dashboard/ }).click()
  const board = orcaPage.locator('[data-agent-dashboard-sheet]')
  await board.waitFor({ state: 'visible' })
  await expect(board.getByText(parked.prompt).first()).toBeVisible()
  await testInfo.attach('before', { body: await board.screenshot(), contentType: 'image/png' })

  await board.getByRole('button', { name: 'Add lane' }).click()
  const nameInput = board.getByRole('textbox', { name: 'New lane name' })
  await nameInput.fill('Waiting')
  await nameInput.press('Enter')
  const waitingLane = board.getByRole('region', { name: 'Waiting' })
  await expect(waitingLane).toBeVisible()

  const draggableCard = (prompt: string) =>
    board.locator('[draggable="true"]', { hasText: prompt }).first()
  await draggableCard(parked.prompt).dragTo(waitingLane)
  await expect(waitingLane.getByText(parked.prompt)).toBeVisible()
  await expect(board.getByRole('region', { name: 'Done' }).getByText(parked.prompt)).toHaveCount(0)

  const persisted = await orcaPage.evaluate((paneKey) => {
    const settings = window.__store?.getState().settings
    const lane = settings?.agentDashboardCustomLanes?.find((l) => l.label === 'Waiting')
    return { laneId: lane?.id, placed: settings?.agentDashboardLaneByPaneKey?.[paneKey] }
  }, parked.paneKey)
  expect(persisted.laneId).toBeTruthy()
  expect(persisted.placed).toBe(persisted.laneId)
  await testInfo.attach('after', { body: await board.screenshot(), contentType: 'image/png' })

  // A parked agent that asks a question surfaces in Needs You, then returns to its lane.
  const setParkedState = (state: 'waiting' | 'done', at: number) =>
    orcaPage.evaluate(
      ({ paneKey, prompt, state, at, worktreeId }) => {
        const store = window.__store
        const tabId = paneKey.split(':')[0]
        store
          ?.getState()
          .setAgentStatus(
            paneKey,
            { state, prompt, agentType: 'claude' },
            'Claude',
            { updatedAt: at, stateStartedAt: at },
            { tabId, terminalHandle: 'agent-dashboard-lanes-1', worktreeId }
          )
      },
      { paneKey: parked.paneKey, prompt: parked.prompt, state, at, worktreeId }
    )
  await setParkedState('waiting', BASE_TIME + 100)
  await expect(
    board.getByRole('region', { name: 'Needs You' }).getByText(parked.prompt)
  ).toBeVisible()
  await setParkedState('done', BASE_TIME + 200)
  await expect(waitingLane.getByText(parked.prompt)).toBeVisible()

  await draggableCard(parked.prompt).dragTo(board.getByRole('region', { name: 'Working' }))
  await expect(board.getByRole('region', { name: 'Done' }).getByText(parked.prompt)).toBeVisible()
  await expect(waitingLane.getByText(parked.prompt)).toHaveCount(0)
})
