import type { Locator, Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'
import { test } from '../../desktop/electron-fixtures/orca-app'
import {
  ensureTerminalVisible,
  waitForActiveWorktree,
  waitForSessionReady
} from '../../desktop/renderer-probes/store'
import { worktreeRow } from './worktree-row-locators'

const SORTABLE_TAB = '[data-testid="sortable-tab"]'

async function seedTwoTabAgents(page: Page, mode: 'full' | 'compact'): Promise<Locator> {
  await waitForSessionReady(page)
  const worktreeId = await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)
  await page.evaluate(
    ({ worktreeId, mode }) => {
      const store = window.__store!
      const state = store.getState()
      state.setAgentActivityDisplayMode(mode)
      state.setWorktreeCardProperties([...state.worktreeCardProperties, 'inline-agents'])
      while ((store.getState().tabsByWorktree[worktreeId] ?? []).length < 2) {
        store.getState().createTab(worktreeId)
      }
    },
    { worktreeId, mode }
  )
  await page.waitForFunction((worktreeId) => {
    const state = window.__store!.getState()
    const tabs = (state.tabsByWorktree[worktreeId] ?? []).slice(0, 2)
    return (
      tabs.length === 2 &&
      tabs.every((tab) => state.terminalLayoutsByTabId[tab.id]?.root?.type === 'leaf')
    )
  }, worktreeId)
  await page.evaluate((worktreeId) => {
    const state = window.__store!.getState()
    const now = Date.now()
    const agents = [
      { title: 'Alpha tab', agentType: 'claude' as const },
      { title: 'Bravo tab', agentType: 'codex' as const }
    ]
    ;(state.tabsByWorktree[worktreeId] ?? []).slice(0, 2).forEach((tab, index) => {
      const leaf = state.terminalLayoutsByTabId[tab.id]!.root!
      if (leaf.type !== 'leaf') {
        throw new Error('Expected a single-pane terminal')
      }
      const { title, agentType } = agents[index]!
      // Alpha starts first, so start-time order and tab order agree until a tab moves.
      const startedAt = now - (2 - index) * 1000
      state.setTabCustomTitle(tab.id, title)
      state.setAgentStatus(
        `${tab.id}:${leaf.leafId}`,
        { state: 'working', prompt: `${title} task`, agentType },
        agentType,
        { updatedAt: startedAt, stateStartedAt: startedAt },
        { tabId: tab.id, worktreeId }
      )
    })
  }, worktreeId)
  const card = worktreeRow(page, worktreeId)
  if (mode === 'compact') {
    // Hidden windows paint no frames, so a real click's stability wait never settles.
    await card.getByRole('button', { name: /2 agents/ }).dispatchEvent('click')
  }
  return card.getByRole('tree', { name: 'Agents' })
}

function agentOrder(agents: Locator) {
  return () => agents.getByText(/^(Alpha|Bravo) tab$/).allInnerTexts()
}

function tabOrder(page: Page) {
  return () =>
    page
      .locator(SORTABLE_TAB)
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-tab-title')))
}

for (const mode of ['full', 'compact'] as const) {
  test(`sidebar agents follow a tab drag (${mode})`, async ({ orcaPage }) => {
    const agents = await seedTwoTabAgents(orcaPage, mode)
    await expect
      .poll(agentOrder(agents), { message: 'Sidebar agents did not start in tab order' })
      .toEqual(['Alpha tab', 'Bravo tab'])

    const from = await orcaPage.locator(SORTABLE_TAB).filter({ hasText: 'Alpha tab' }).boundingBox()
    const to = await orcaPage.locator(SORTABLE_TAB).filter({ hasText: 'Bravo tab' }).boundingBox()
    if (!from || !to) {
      throw new Error('Missing tab bounds')
    }
    await orcaPage.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
    await orcaPage.mouse.down()
    // Drag far enough for dnd-kit to reorder before release.
    await orcaPage.mouse.move(to.x + to.width * 0.8, to.y + to.height / 2, { steps: 8 })
    await orcaPage.mouse.up()

    await expect
      .poll(tabOrder(orcaPage), { message: 'Tab drag did not reorder the tab strip' })
      .toEqual(['Bravo tab', 'Alpha tab'])
    await expect
      .poll(agentOrder(agents), { message: 'Sidebar agents did not follow the dragged tab' })
      .toEqual(['Bravo tab', 'Alpha tab'])
  })
}

test('sidebar agents follow a pinned tab', async ({ orcaPage }) => {
  const agents = await seedTwoTabAgents(orcaPage, 'full')
  await expect
    .poll(agentOrder(agents), { message: 'Sidebar agents did not start in tab order' })
    .toEqual(['Alpha tab', 'Bravo tab'])

  await orcaPage
    .locator(SORTABLE_TAB)
    .filter({ hasText: 'Bravo tab' })
    .click({ button: 'right', force: true })
  await orcaPage.getByRole('menuitem', { name: 'Pin Tab' }).click({ force: true })

  await expect
    .poll(tabOrder(orcaPage), { message: 'Pinning did not move the tab first' })
    .toEqual(['Bravo tab', 'Alpha tab'])
  await expect
    .poll(agentOrder(agents), { message: 'Sidebar agents did not follow the pinned tab' })
    .toEqual(['Bravo tab', 'Alpha tab'])
})
