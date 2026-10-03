import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import {
  ensureTerminalVisible,
  getActiveTabId,
  getActiveWorktreeId,
  getWorktreeTabs,
  waitForActiveWorktree,
  waitForSessionReady,
  waitForStartupWorktreeRefresh
} from './helpers/store'
import { SORTABLE_TAB } from './helpers/terminal-tab-menu'
import {
  execInTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'

type StripTerminalTab = { id: string; entityId: string }
type ClusterPane = { worktreeId: string; groupId: string; tabs: StripTerminalTab[] }

const selectionModifier = process.platform === 'darwin' ? 'Meta' : 'Control'

function paneStrip(page: Page, groupId: string) {
  return page.locator(`[data-tab-group-strip-id="${groupId}"]`)
}

function terminalTab(page: Page, groupId: string, tab: StripTerminalTab) {
  return paneStrip(page, groupId).locator(`${SORTABLE_TAB}[data-tab-id="${tab.entityId}"]`)
}

function clusterChip(page: Page, groupId: string, clusterId: string) {
  return paneStrip(page, groupId).locator(`[data-tab-cluster-chip="${clusterId}"]`)
}

async function readPanes(page: Page, worktreeId: string) {
  return page.evaluate((id) => window.__store?.getState().groupsByWorktree[id] ?? [], worktreeId)
}

async function readPane(page: Page, pane: Pick<ClusterPane, 'worktreeId' | 'groupId'>) {
  return (await readPanes(page, pane.worktreeId)).find((group) => group.id === pane.groupId)
}

async function readCluster(page: Page, pane: ClusterPane, clusterId: string) {
  return (await readPane(page, pane))?.tabClusters?.find((cluster) => cluster.id === clusterId)
}

async function prepareTerminalPane(page: Page, terminalCount = 3): Promise<ClusterPane> {
  await waitForSessionReady(page)
  await waitForStartupWorktreeRefresh(page)
  const worktreeId = await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)
  const initialTabId = await getActiveTabId(page)
  if (!initialTabId) {
    throw new Error('No initial terminal tab is active')
  }
  await expect(page.locator(`${SORTABLE_TAB}[data-tab-id="${initialTabId}"]`)).toBeVisible()
  // Why: the "+" menu is nonmodal and a just-spawned terminal's focus can close it mid-click.
  for (let created = 1; created < terminalCount; created += 1) {
    const tabsBefore = await page.locator(SORTABLE_TAB).count()
    await page.evaluate(() => document.body.focus())
    await page.keyboard.press(`${selectionModifier}+t`)
    await expect.poll(() => page.locator(SORTABLE_TAB).count()).toBe(tabsBefore + 1)
    await waitForActiveTerminalManager(page)
    await waitForActivePanePtyId(page)
  }

  await expect.poll(() => getWorktreeTabs(page, worktreeId)).toHaveLength(terminalCount)
  const pane = await page.evaluate((id) => {
    const state = window.__store?.getState()
    if (!state) {
      throw new Error('The app store is unavailable')
    }
    const group = state.groupsByWorktree[id]?.find(
      (candidate) => candidate.id === state.activeGroupIdByWorktree[id]
    )
    if (!group) {
      throw new Error('No active pane exists for the terminal tabs')
    }
    const tabs = group.tabOrder.flatMap((tabId) => {
      const tab = state.unifiedTabsByWorktree[id]?.find(
        (candidate) => candidate.id === tabId && candidate.contentType === 'terminal'
      )
      return tab ? [{ id: tab.id, entityId: tab.entityId }] : []
    })
    return { worktreeId: id, groupId: group.id, tabs }
  }, worktreeId)
  expect(pane.tabs).toHaveLength(terminalCount)
  for (const tab of pane.tabs) {
    await expect(terminalTab(page, pane.groupId, tab)).toBeVisible()
  }
  return pane
}

async function createNamedClusterFromMenu(
  page: Page,
  pane: ClusterPane,
  name: string,
  selectedMembers?: StripTerminalTab[]
) {
  const members = selectedMembers ?? pane.tabs.filter((_, index) => index === 0 || index === 2)
  const first = members[0]
  const memberIds = members.map((tab) => tab.id)
  const outside = pane.tabs.find((tab) => !memberIds.includes(tab.id))
  if (!first || members.length !== 2 || !outside) {
    throw new Error('Grouping requires two members and an outside terminal tab')
  }
  await terminalTab(page, pane.groupId, outside).click()
  // Why: the first toggle seeds the active outside tab, which must leave the selection.
  for (const tab of [...members, outside]) {
    await terminalTab(page, pane.groupId, tab).click({ modifiers: [selectionModifier] })
  }
  await expect
    .poll(() =>
      page.evaluate(
        (groupId) => window.__store?.getState().tabSelectionByGroupId[groupId]?.tabIds ?? [],
        pane.groupId
      )
    )
    .toEqual(memberIds)
  for (const tab of members) {
    await expect(terminalTab(page, pane.groupId, tab)).toHaveAttribute(
      'data-tab-highlighted',
      'true'
    )
  }
  await expect(terminalTab(page, pane.groupId, outside)).not.toHaveAttribute(
    'data-tab-highlighted',
    'true'
  )
  await expect(terminalTab(page, pane.groupId, outside)).toHaveAttribute('data-active', 'true')

  await terminalTab(page, pane.groupId, first).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Add 2 Tabs to New Group', exact: true }).click()
  const renameInput = paneStrip(page, pane.groupId).getByRole('textbox', {
    name: 'Rename Group',
    exact: true
  })
  await expect(renameInput).toBeVisible()
  await expect(renameInput).toBeFocused()
  const clusterId = await renameInput.getAttribute('data-tab-cluster-rename-input')
  if (!clusterId) {
    throw new Error('The new group has no inline rename identity')
  }
  await expect(clusterChip(page, pane.groupId, clusterId)).toBeVisible()
  await page.keyboard.type(name)
  await page.keyboard.press('Enter')
  await expect(renameInput).toBeHidden()
  await expect
    .poll(() => readCluster(page, pane, clusterId))
    .toMatchObject({ name, tabIds: memberIds, collapsed: false })
  await expect
    .poll(async () => {
      const group = await readPane(page, pane)
      const start = group?.tabOrder.indexOf(first.id) ?? -1
      return group?.tabOrder.slice(start, start + members.length)
    })
    .toEqual(memberIds)
  await expect(clusterChip(page, pane.groupId, clusterId)).toHaveText(name)
  return { clusterId, members, memberIds, outside }
}

test.describe('Tab clusters', () => {
  test('groups highlighted tabs, collapses around the active member, and cancels a rename', async ({
    orcaPage
  }) => {
    const pane = await prepareTerminalPane(orcaPage)
    const { clusterId, members, outside } = await createNamedClusterFromMenu(
      orcaPage,
      pane,
      'Build terminals'
    )
    const chip = clusterChip(orcaPage, pane.groupId, clusterId)
    const [activeMember, hiddenMember] = members
    if (!activeMember || !hiddenMember) {
      throw new Error('The group must contain two tabs')
    }
    await terminalTab(orcaPage, pane.groupId, activeMember).click()
    await chip.click()
    await expect
      .poll(() => readCluster(orcaPage, pane, clusterId))
      .toMatchObject({ collapsed: true })
    await expect(chip).toHaveAttribute('aria-expanded', 'false')
    await expect(chip).toContainText('2')
    await expect(terminalTab(orcaPage, pane.groupId, activeMember)).toHaveAttribute(
      'data-active',
      'true'
    )
    await expect(terminalTab(orcaPage, pane.groupId, activeMember)).toBeVisible()
    await expect(terminalTab(orcaPage, pane.groupId, hiddenMember)).toBeHidden()
    await expect(terminalTab(orcaPage, pane.groupId, outside)).toBeVisible()

    await terminalTab(orcaPage, pane.groupId, outside).click()
    await expect(terminalTab(orcaPage, pane.groupId, activeMember)).toBeVisible()
    await expect(terminalTab(orcaPage, pane.groupId, hiddenMember)).toBeHidden()
    await expect(chip).toHaveAttribute('aria-expanded', 'false')
    await chip.click()
    await expect
      .poll(() => readCluster(orcaPage, pane, clusterId))
      .toMatchObject({ collapsed: false })
    await expect(chip).toHaveAttribute('aria-expanded', 'true')
    for (const tab of members) {
      await expect(terminalTab(orcaPage, pane.groupId, tab)).toBeVisible()
    }

    await chip.dblclick()
    const renameInput = chip.getByRole('textbox', { name: 'Rename Group', exact: true })
    await expect(renameInput).toBeFocused()
    await expect(renameInput).toHaveValue('Build terminals')
    await renameInput.fill('Discard this name')
    await renameInput.press('Escape')
    await expect(renameInput).toBeHidden()
    await expect
      .poll(() => readCluster(orcaPage, pane, clusterId))
      .toMatchObject({ name: 'Build terminals' })
    await expect(chip).toHaveText('Build terminals')
  })

  test('keeps a collapsed member visible when switching away and closes only that tab', async ({
    orcaPage
  }) => {
    const pane = await prepareTerminalPane(orcaPage)
    const { clusterId, members, outside } = await createNamedClusterFromMenu(
      orcaPage,
      pane,
      'Sticky terminals'
    )
    const [stickyMember, hiddenMember] = members
    if (!stickyMember || !hiddenMember) {
      throw new Error('The group must contain two tabs')
    }
    const chip = clusterChip(orcaPage, pane.groupId, clusterId)
    const stickyTab = terminalTab(orcaPage, pane.groupId, stickyMember)
    const hiddenTab = terminalTab(orcaPage, pane.groupId, hiddenMember)
    const outsideTab = terminalTab(orcaPage, pane.groupId, outside)

    await stickyTab.click()
    await chip.click()
    await expect
      .poll(() => readCluster(orcaPage, pane, clusterId))
      .toMatchObject({ collapsed: true })
    await expect(chip).toHaveAttribute('aria-expanded', 'false')
    await expect(stickyTab).toBeVisible()
    await expect(stickyTab).toHaveAttribute('data-active', 'true')
    await expect(hiddenTab).toBeHidden()

    await outsideTab.click()
    await expect(outsideTab).toHaveAttribute('data-active', 'true')
    await expect(stickyTab).toBeVisible()
    await expect(hiddenTab).toBeHidden()
    await stickyTab.click()
    await expect(stickyTab).toHaveAttribute('data-active', 'true')
    await expect(hiddenTab).toBeHidden()
    await outsideTab.click()
    await expect(outsideTab).toHaveAttribute('data-active', 'true')
    await expect(stickyTab).toBeVisible()
    await expect(hiddenTab).toBeHidden()

    await stickyTab.hover()
    await stickyTab.getByRole('button', { name: /^Close tab /i }).click()
    const confirmation = orcaPage.getByRole('dialog', {
      name: 'Stop running command?',
      exact: true
    })
    // Why: a shell still starting can require confirmation even without a launched command.
    await expect
      .poll(async () => (await confirmation.isVisible()) || (await stickyTab.count()) === 0)
      .toBe(true)
    if (await confirmation.isVisible()) {
      await confirmation.getByRole('button', { name: 'Stop and Close', exact: true }).click()
    }
    await expect(stickyTab).toHaveCount(0)
    await expect(hiddenTab).toBeHidden()
    await expect(outsideTab).toHaveAttribute('data-active', 'true')
    await expect(chip).toBeVisible()
    await expect(chip).toHaveAttribute('aria-expanded', 'false')
    await expect(chip).toContainText('1')

    await chip.click()
    await expect(chip).toHaveAttribute('aria-expanded', 'true')
    await expect(hiddenTab).toBeVisible()
    await outsideTab.click()
    await chip.click()
    await expect(chip).toHaveAttribute('aria-expanded', 'false')
    await expect(hiddenTab).toBeHidden()
    await expect(outsideTab).toHaveAttribute('data-active', 'true')
  })

  test('cycles and numbers only visible tabs while a collapsed middle group keeps its sticky member', async ({
    orcaPage,
    electronApp
  }) => {
    const pane = await prepareTerminalPane(orcaPage, 4)
    const [left, stickyMember, hiddenMember, right] = pane.tabs
    if (!left || !stickyMember || !hiddenMember || !right) {
      throw new Error('Visible shortcut coverage requires four terminal tabs')
    }
    const { clusterId } = await createNamedClusterFromMenu(orcaPage, pane, 'Keyboard group', [
      stickyMember,
      hiddenMember
    ])
    const chip = clusterChip(orcaPage, pane.groupId, clusterId)
    const stickyTab = terminalTab(orcaPage, pane.groupId, stickyMember)
    const hiddenTab = terminalTab(orcaPage, pane.groupId, hiddenMember)
    await stickyTab.click()
    await chip.click()
    await terminalTab(orcaPage, pane.groupId, right).click()
    await expect
      .poll(() => readCluster(orcaPage, pane, clusterId))
      .toMatchObject({ collapsed: true, shownTabId: stickyMember.id })
    await expect(stickyTab).toBeVisible()
    await expect(hiddenTab).toBeHidden()
    await expect(terminalTab(orcaPage, pane.groupId, right)).toHaveAttribute('data-active', 'true')

    const visibleTabs = paneStrip(orcaPage, pane.groupId).locator(`${SORTABLE_TAB}:visible`)
    const visibleOrder = await visibleTabs.evaluateAll((tabs) =>
      tabs.map((tab) => tab.getAttribute('data-tab-id'))
    )
    expect(visibleOrder).toEqual([left.entityId, stickyMember.entityId, right.entityId])

    for (const tab of [left, stickyMember, right, left, stickyMember, right]) {
      await orcaPage.keyboard.press(`${selectionModifier}+Shift+]`)
      await expect(terminalTab(orcaPage, pane.groupId, tab)).toHaveAttribute('data-active', 'true')
      await expect(hiddenTab).toBeHidden()
      await expect(stickyTab).toBeVisible()
      await expect(chip).toHaveAttribute('aria-expanded', 'false')
    }

    for (const [index, entityId] of visibleOrder.entries()) {
      expect(
        await visibleTabs.evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute('data-tab-id')))
      ).toEqual(visibleOrder)
      if (!entityId) {
        throw new Error('A visible sortable tab has no backing tab identity')
      }
      // Why: synthetic CDP keys never reach main's before-input-event router (unit-tested
      // separately), so send the IPC that router emits for Select Tab N.
      await electronApp.evaluate(({ BrowserWindow }, tabIndex) => {
        for (const window of BrowserWindow.getAllWindows()) {
          window.webContents.send('ui:jumpToTabIndex', tabIndex)
        }
      }, index)
      await expect(
        paneStrip(orcaPage, pane.groupId).locator(`${SORTABLE_TAB}[data-active="true"]:visible`)
      ).toHaveAttribute('data-tab-id', entityId)
      await expect(hiddenTab).toBeHidden()
      await expect(stickyTab).toBeVisible()
    }
    await expect
      .poll(() => readCluster(orcaPage, pane, clusterId))
      .toMatchObject({ collapsed: true, shownTabId: stickyMember.id })
  })

  test('Ctrl+Tab MRU switcher activates a hidden member and preserves the sticky member after leaving', async ({
    orcaPage
  }) => {
    const pane = await prepareTerminalPane(orcaPage, 4)
    await orcaPage.evaluate(async () => {
      await window.__store?.getState().updateSettings({ ctrlTabOrderMode: 'mru' })
    })
    const [, stickyMember, hiddenMember, outside] = pane.tabs
    if (!stickyMember || !hiddenMember || !outside) {
      throw new Error('Ctrl+Tab coverage requires four terminal tabs')
    }
    const { clusterId } = await createNamedClusterFromMenu(orcaPage, pane, 'MRU group', [
      stickyMember,
      hiddenMember
    ])
    const chip = clusterChip(orcaPage, pane.groupId, clusterId)
    const stickyTab = terminalTab(orcaPage, pane.groupId, stickyMember)
    const hiddenTab = terminalTab(orcaPage, pane.groupId, hiddenMember)
    const outsideTab = terminalTab(orcaPage, pane.groupId, outside)
    await hiddenTab.click()
    await stickyTab.click()
    await chip.click()
    await outsideTab.click()
    await expect
      .poll(async () => (await readPane(orcaPage, pane))?.recentTabIds?.slice(-3))
      .toEqual([hiddenMember.id, stickyMember.id, outside.id])
    await expect
      .poll(() => readCluster(orcaPage, pane, clusterId))
      .toMatchObject({ collapsed: true, shownTabId: stickyMember.id })
    await expect(outsideTab).toHaveAttribute('data-active', 'true')
    await expect(stickyTab).toBeVisible()
    await expect(hiddenTab).toBeHidden()

    const switcher = orcaPage.getByRole('listbox', { name: 'Switch tabs', exact: true })
    // Why: terminal-window Ctrl+Tab reaches the renderer; IPC forwarding belongs to browser guests.
    await orcaPage.keyboard.down('Control')
    try {
      await orcaPage.keyboard.press('Tab')
      await expect(switcher).toBeVisible()
      await expect(switcher.getByRole('option')).toHaveCount(4)
      await expect(outsideTab).toHaveAttribute('data-active', 'true')
      await orcaPage.keyboard.press('Tab')
      await expect(outsideTab).toHaveAttribute('data-active', 'true')
    } finally {
      await orcaPage.keyboard.up('Control')
    }

    await expect(switcher).toBeHidden()
    await expect(hiddenTab).toHaveAttribute('data-active', 'true')
    await expect(hiddenTab).toBeVisible()
    await expect(stickyTab).toBeVisible()
    await expect(chip).toHaveAttribute('aria-expanded', 'false')
    await outsideTab.click()
    await expect(outsideTab).toHaveAttribute('data-active', 'true')
    await expect(stickyTab).toBeVisible()
    await expect(hiddenTab).toBeHidden()
    await expect
      .poll(() => readCluster(orcaPage, pane, clusterId))
      .toMatchObject({ collapsed: true, shownTabId: stickyMember.id })
  })

  test('ungroups without closing tabs, then closes every member of a regrouped cluster', async ({
    orcaPage
  }) => {
    const pane = await prepareTerminalPane(orcaPage)
    const firstCluster = await createNamedClusterFromMenu(orcaPage, pane, 'Keep these tabs')
    const firstChip = clusterChip(orcaPage, pane.groupId, firstCluster.clusterId)
    const groupedOrder = (await readPane(orcaPage, pane))?.tabOrder
    await firstChip.click({ button: 'right' })
    await orcaPage.getByRole('menuitem', { name: 'Ungroup', exact: true }).click()
    await expect.poll(async () => (await readPane(orcaPage, pane))?.tabClusters ?? []).toEqual([])
    await expect.poll(async () => (await readPane(orcaPage, pane))?.tabOrder).toEqual(groupedOrder)
    await expect
      .poll(async () =>
        (await getWorktreeTabs(orcaPage, pane.worktreeId)).map((tab) => tab.id).sort()
      )
      .toEqual(pane.tabs.map((tab) => tab.entityId).sort())
    await expect(firstChip).toBeHidden()
    for (const tab of pane.tabs) {
      await expect(terminalTab(orcaPage, pane.groupId, tab)).toBeVisible()
    }

    const regrouped = await createNamedClusterFromMenu(orcaPage, pane, 'Close these tabs')
    const chip = clusterChip(orcaPage, pane.groupId, regrouped.clusterId)
    await chip.click({ button: 'right' })
    await orcaPage.getByRole('menuitem', { name: 'Close Group', exact: true }).click()
    const confirmation = orcaPage.getByRole('dialog', {
      name: 'Stop running commands?',
      exact: true
    })
    for (const member of regrouped.members) {
      const tab = terminalTab(orcaPage, pane.groupId, member)
      // Why: a shell still starting can briefly require confirmation even without a launched command.
      await expect
        .poll(async () => (await confirmation.isVisible()) || (await tab.count()) === 0)
        .toBe(true)
      if (await confirmation.isVisible()) {
        await confirmation.getByRole('button', { name: 'Stop and Close', exact: true }).click()
      }
      await expect(tab).toBeHidden()
    }
    await expect
      .poll(async () => (await getWorktreeTabs(orcaPage, pane.worktreeId)).map((tab) => tab.id))
      .toEqual([regrouped.outside.entityId])
    await expect.poll(async () => (await readPane(orcaPage, pane))?.tabClusters ?? []).toEqual([])
    await expect(chip).toBeHidden()
    await expect(terminalTab(orcaPage, pane.groupId, regrouped.outside)).toBeVisible()
  })

  test('warns once for all running group members, cancels atomically, and closes them together', async ({
    orcaPage
  }) => {
    const pane = await prepareTerminalPane(orcaPage)
    const { clusterId, members, outside } = await createNamedClusterFromMenu(
      orcaPage,
      pane,
      'Busy group'
    )
    const [buildTab, testTab] = members
    if (!buildTab || !testTab) {
      throw new Error('The group must contain two running terminals')
    }
    const labelledTabs = [
      { tab: buildTab, title: 'Cluster build worker' },
      { tab: testTab, title: 'Cluster test worker' },
      { tab: outside, title: 'Cluster idle shell' }
    ]
    for (const { tab, title } of labelledTabs) {
      const tabElement = terminalTab(orcaPage, pane.groupId, tab)
      await tabElement.dblclick()
      const renameInput = tabElement.getByRole('textbox')
      await renameInput.fill(title)
      await renameInput.press('Enter')
      await expect(tabElement).toHaveAttribute('data-tab-title', title)
      await tabElement.click()
      await waitForActiveTerminalManager(orcaPage)
      const ptyId = await waitForActivePanePtyId(orcaPage)
      const readyMarker = `cluster-close-ready-${tab.entityId}`
      await execInTerminal(orcaPage, ptyId, `echo ${readyMarker}`)
      await waitForTerminalOutput(orcaPage, readyMarker, 20_000)
      if (tab.id !== outside.id) {
        await execInTerminal(orcaPage, ptyId, 'sleep 300')
        await expect
          .poll(
            async () =>
              (await orcaPage.evaluate((id) => window.api.pty.inspectProcess(id), ptyId))
                .foregroundProcess,
            { timeout: 20_000, message: 'sleep 300 never became the foreground process' }
          )
          .toBe('sleep')
      }
    }
    await terminalTab(orcaPage, pane.groupId, outside).click({ button: 'right' })
    await orcaPage.getByRole('menuitem', { name: 'Add to Group', exact: true }).hover()
    await orcaPage.getByRole('menuitem', { name: 'Busy group', exact: true }).click()
    const memberIds = labelledTabs.map(({ tab }) => tab.id)
    await expect
      .poll(() => readCluster(orcaPage, pane, clusterId))
      .toMatchObject({ tabIds: memberIds })

    const chip = clusterChip(orcaPage, pane.groupId, clusterId)
    await chip.click({ button: 'right' })
    await orcaPage.getByRole('menuitem', { name: 'Close Group', exact: true }).click()
    const confirmation = orcaPage.getByRole('dialog', {
      name: 'Stop running commands?',
      exact: true
    })
    await expect(confirmation).toBeVisible()
    await expect(orcaPage.getByRole('dialog')).toHaveCount(1)
    await expect(confirmation).toContainText('Closing this group will stop 2 running terminals.')
    await expect(confirmation.getByText('Busy group', { exact: true })).toBeVisible()
    await expect(
      confirmation.getByRole('checkbox', {
        name: "Don't ask again for running terminals",
        exact: true
      })
    ).toBeVisible()
    const runningTerminals = confirmation.getByRole('region', {
      name: 'Running terminals',
      exact: true
    })
    await expect(runningTerminals).toBeHidden()
    await confirmation
      .getByRole('button', { name: 'Show 2 running terminals', exact: true })
      .click()
    await expect(runningTerminals).toBeVisible()
    await expect(runningTerminals.getByText('Cluster build worker', { exact: true })).toBeVisible()
    await expect(runningTerminals.getByText('Cluster test worker', { exact: true })).toBeVisible()
    await expect(runningTerminals.getByText('Cluster idle shell', { exact: true })).toHaveCount(0)
    await expect(runningTerminals.getByRole('listitem')).toHaveCount(2)
    await expect(
      confirmation.getByRole('button', { name: 'Hide running terminals', exact: true })
    ).toBeVisible()
    await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(confirmation).toBeHidden()
    await expect
      .poll(() => readCluster(orcaPage, pane, clusterId))
      .toMatchObject({ tabIds: memberIds })
    for (const { tab } of labelledTabs) {
      await expect(terminalTab(orcaPage, pane.groupId, tab)).toBeVisible()
    }
    await expect(chip).toHaveText('Busy group')

    await chip.click({ button: 'right' })
    await orcaPage.getByRole('menuitem', { name: 'Close Group', exact: true }).click()
    await expect(confirmation).toBeVisible()
    await confirmation.getByRole('button', { name: 'Stop and Close', exact: true }).click()
    await expect(confirmation).toBeHidden()
    await expect.poll(() => getWorktreeTabs(orcaPage, pane.worktreeId)).toEqual([])
    await expect.poll(() => readCluster(orcaPage, pane, clusterId)).toBeUndefined()
    for (const { tab } of labelledTabs) {
      await expect(terminalTab(orcaPage, pane.groupId, tab)).toBeHidden()
    }
    const warningDialog = orcaPage.getByRole('dialog', {
      name: /^Stop (?:running commands?|these agents|this agent)\?$/
    })
    let sawAnotherDialog = false
    const observationStarted = Date.now()
    await expect
      .poll(
        async () => {
          sawAnotherDialog ||= await warningDialog.isVisible()
          return sawAnotherDialog || Date.now() - observationStarted >= 1_500
        },
        { timeout: 3_000, intervals: [100] }
      )
      .toBe(true)
    expect(sawAnotherDialog, 'Confirming the group must not queue another terminal warning').toBe(
      false
    )
    await expect(chip).toBeHidden()
  })

  test('restores a named collapsed cluster after an app restart', async ({
    testRepoPath
  }, testInfo) => {
    test.setTimeout(300_000)
    const session = createRestartSession(testInfo)
    let firstApp: ElectronApplication | null = null
    let secondApp: ElectronApplication | null = null
    try {
      const first = await session.launch()
      firstApp = first.app
      await waitForSessionReady(first.page)
      await waitForStartupWorktreeRefresh(first.page)
      await attachRepoAndOpenTerminal(first.page, testRepoPath)
      const pane = await prepareTerminalPane(first.page)
      const { clusterId, memberIds } = await createNamedClusterFromMenu(
        first.page,
        pane,
        'Saved group'
      )
      await clusterChip(first.page, pane.groupId, clusterId).click()
      await expect
        .poll(() => readCluster(first.page, pane, clusterId))
        .toMatchObject({ name: 'Saved group', collapsed: true })
      await expect(clusterChip(first.page, pane.groupId, clusterId)).toHaveAttribute(
        'aria-expanded',
        'false'
      )
      await session.close(firstApp)
      firstApp = null

      const second = await session.launch()
      secondApp = second.app
      await waitForSessionReady(second.page)
      await waitForStartupWorktreeRefresh(second.page)
      await expect.poll(() => getActiveWorktreeId(second.page)).toBe(pane.worktreeId)
      await expect
        .poll(() => readCluster(second.page, pane, clusterId))
        .toMatchObject({ name: 'Saved group', collapsed: true, tabIds: memberIds })
      const restoredPane = await readPane(second.page, pane)
      for (const tab of pane.tabs.filter((candidate) => memberIds.includes(candidate.id))) {
        const memberTab = terminalTab(second.page, pane.groupId, tab)
        await (tab.id === restoredPane?.activeTabId
          ? expect(memberTab).toBeVisible()
          : expect(memberTab).toBeHidden())
      }
      const restoredChip = clusterChip(second.page, pane.groupId, clusterId)
      await expect(restoredChip).toBeVisible()
      await expect(restoredChip).toContainText('Saved group')
      await expect(restoredChip).toHaveAttribute('aria-expanded', 'false')
    } finally {
      try {
        if (secondApp) {
          await session.close(secondApp)
        }
      } finally {
        try {
          if (firstApp) {
            await session.close(firstApp)
          }
        } finally {
          await session.dispose()
        }
      }
    }
  })

  test('preserves the cluster when moving to a new split and merging back', async ({
    orcaPage
  }) => {
    const pane = await prepareTerminalPane(orcaPage)
    const { clusterId, memberIds, members, outside } = await createNamedClusterFromMenu(
      orcaPage,
      pane,
      'Split group'
    )
    const originalCluster = await readCluster(orcaPage, pane, clusterId)
    if (!originalCluster) {
      throw new Error('The group was not created')
    }
    await clusterChip(orcaPage, pane.groupId, clusterId).click({ button: 'right' })
    await orcaPage.getByRole('menuitem', { name: 'Move Group to New Split', exact: true }).hover()
    await orcaPage.getByRole('menuitem', { name: 'Right', exact: true }).click()
    await expect.poll(() => readPanes(orcaPage, pane.worktreeId)).toHaveLength(2)
    await expect
      .poll(async () => {
        const groups = await readPanes(orcaPage, pane.worktreeId)
        const destination = groups.find((group) => group.id !== pane.groupId)
        return { tabOrder: destination?.tabOrder, clusters: destination?.tabClusters }
      })
      .toEqual({ tabOrder: memberIds, clusters: [originalCluster] })
    const newPane = (await readPanes(orcaPage, pane.worktreeId)).find(
      (group) => group.id !== pane.groupId
    )
    if (!newPane) {
      throw new Error('Moving the group did not create a new pane')
    }
    await expect.poll(async () => (await readPane(orcaPage, pane))?.tabOrder).toEqual([outside.id])
    await expect(clusterChip(orcaPage, pane.groupId, clusterId)).toBeHidden()
    await expect(terminalTab(orcaPage, pane.groupId, outside)).toBeVisible()
    await expect(clusterChip(orcaPage, newPane.id, clusterId)).toHaveText('Split group')
    for (const member of members) {
      await expect(terminalTab(orcaPage, newPane.id, member)).toBeVisible()
      await expect(terminalTab(orcaPage, pane.groupId, member)).toBeHidden()
    }

    const mergedGroupId = await orcaPage.evaluate(
      ({ worktreeId, groupId }) =>
        window.__store?.getState().mergeGroupIntoSibling(worktreeId, groupId),
      { worktreeId: pane.worktreeId, groupId: newPane.id }
    )
    if (!mergedGroupId) {
      throw new Error('The split pane did not merge into its sibling')
    }
    await expect
      .poll(async () => {
        const groups = await readPanes(orcaPage, pane.worktreeId)
        return groups.map((group) => ({ id: group.id, clusters: group.tabClusters }))
      })
      .toEqual([{ id: mergedGroupId, clusters: [originalCluster] }])
    await expect(paneStrip(orcaPage, newPane.id)).toBeHidden()
    for (const tab of pane.tabs) {
      await expect(terminalTab(orcaPage, mergedGroupId, tab)).toBeVisible()
    }
    await expect(clusterChip(orcaPage, mergedGroupId, clusterId)).toHaveText('Split group')
  })
})
