import type { Locator, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import { getProjectGroupHeaderPaddingLeft } from '../../src/renderer/src/components/sidebar/worktree-list/rows/indentation'

async function showProjectGroupTree(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const state = window.__store!.getState()
    // Why: the host OS locale drives the default UI language; pin English for stable menu labels.
    await state.updateSettings({ uiLanguage: 'en' })
    state.setActiveView('terminal')
    state.setSidebarOpen(true)
    state.setGroupBy('repo')
    state.setProjectOrderBy('manual')
  })
}

/** Creates each group inside the previous one and returns their ids in order. */
async function seedGroupChain(page: Page, names: readonly string[]): Promise<string[]> {
  return page.evaluate(async (groupNames) => {
    const store = window.__store!
    const ids: string[] = []
    for (const name of groupNames) {
      const parentGroupId = ids.at(-1)
      const group = await store
        .getState()
        .createProjectGroup(name, parentGroupId ? { parentGroupId } : undefined)
      if (!group) {
        throw new Error(`Failed to create Project Group: ${name}`)
      }
      ids.push(group.id)
    }
    return ids
  }, names)
}

function groupHeader(page: Page, groupId: string): Locator {
  return page.locator(`[data-worktree-sidebar] [data-project-group-header-id="${groupId}"]`)
}

async function expectGroupDepth(header: Locator, depth: number): Promise<void> {
  await expect(header).toBeVisible()
  await expect(header).toHaveCSS('padding-left', `${getProjectGroupHeaderPaddingLeft(depth)}px`)
}

async function openGroupActions(page: Page, groupId: string, name: string): Promise<void> {
  const header = groupHeader(page, groupId)
  // Why: the actions button only takes width while its header is hovered.
  await header.hover()
  await header.getByRole('button', { name: `Group actions for ${name}`, exact: true }).click()
}

async function openMoveSubmenu(page: Page): Promise<void> {
  await page.getByRole('menuitem', { name: 'Move to group', exact: true }).click()
  await expect(page.getByRole('menuitem', { name: 'Top level', exact: true })).toBeVisible()
}

async function closeMenus(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
}

function moveTarget(page: Page, groupId: string): Locator {
  return page.locator(`[data-project-group-move-target="${groupId}"]`)
}

test.describe('Project Group nesting', () => {
  test('creates a subgroup from the group menu', async ({ orcaPage }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await showProjectGroupTree(orcaPage)
    const [clientsId] = await seedGroupChain(orcaPage, ['Clients'])
    await expectGroupDepth(groupHeader(orcaPage, clientsId!), 0)

    await openGroupActions(orcaPage, clientsId!, 'Clients')
    await orcaPage.getByRole('menuitem', { name: 'New subgroup', exact: true }).click()
    const dialog = orcaPage.getByRole('dialog', { name: 'New Subgroup' })
    await expect(dialog).toContainText('Create a group inside "Clients".')
    await dialog.getByRole('textbox').fill('Acme')
    await dialog.getByRole('button', { name: 'Create', exact: true }).click()
    // Why: wait for the whole dialog to unmount; its title changes while it animates out.
    await expect(orcaPage.getByRole('dialog')).toHaveCount(0)

    const subgroup = orcaPage
      .locator('[data-worktree-sidebar] [data-project-group-header-id]')
      .filter({ has: orcaPage.getByText('Acme', { exact: true }) })
    await expectGroupDepth(subgroup, 1)
    await expectGroupDepth(groupHeader(orcaPage, clientsId!), 0)
    await orcaPage.screenshot({ path: testInfo.outputPath('subgroup-created.png') })
  })

  test('disables New subgroup on a third-level group', async ({ orcaPage }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await showProjectGroupTree(orcaPage)
    const names = ['Level 1', 'Level 2', 'Level 3']
    const ids = await seedGroupChain(orcaPage, names)
    for (const [depth, id] of ids.entries()) {
      await expectGroupDepth(groupHeader(orcaPage, id), depth)
    }
    await orcaPage.screenshot({ path: testInfo.outputPath('three-levels.png') })

    const newSubgroup = orcaPage.getByRole('menuitem', { name: 'New subgroup', exact: true })
    await openGroupActions(orcaPage, ids[1]!, 'Level 2')
    await expect(newSubgroup).toBeEnabled()
    await closeMenus(orcaPage)
    await openGroupActions(orcaPage, ids[2]!, 'Level 3')
    await expect(newSubgroup).toBeDisabled()
  })

  test('moves a group under another group and back to the top level', async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await showProjectGroupTree(orcaPage)
    const [clientsId] = await seedGroupChain(orcaPage, ['Clients'])
    const [acmeId] = await seedGroupChain(orcaPage, ['Acme'])
    const acme = groupHeader(orcaPage, acmeId!)
    await expectGroupDepth(acme, 0)

    await openGroupActions(orcaPage, acmeId!, 'Acme')
    await openMoveSubmenu(orcaPage)
    await expect(orcaPage.getByRole('menuitem', { name: 'Top level', exact: true })).toBeDisabled()
    await moveTarget(orcaPage, clientsId!).click()
    await expectGroupDepth(acme, 1)

    await openGroupActions(orcaPage, acmeId!, 'Acme')
    await openMoveSubmenu(orcaPage)
    // The current parent stays listed but cannot be picked again.
    await expect(moveTarget(orcaPage, clientsId!)).toBeDisabled()
    await orcaPage.getByRole('menuitem', { name: 'Top level', exact: true }).click()
    await expectGroupDepth(acme, 0)
  })

  test('never offers a group or its subgroups as its own move target', async ({
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await showProjectGroupTree(orcaPage)
    const [rootId, childId, grandchildId] = await seedGroupChain(orcaPage, [
      'Root',
      'Child',
      'Grandchild'
    ])
    const [otherId] = await seedGroupChain(orcaPage, ['Other'])
    await expectGroupDepth(groupHeader(orcaPage, grandchildId!), 2)

    // Root already spans three levels at the top, so it has nowhere to go and the submenu is dropped.
    await openGroupActions(orcaPage, rootId!, 'Root')
    await expect(
      orcaPage.getByRole('menuitem', { name: 'Rename group', exact: true })
    ).toBeVisible()
    await expect(
      orcaPage.getByRole('menuitem', { name: 'Move to group', exact: true })
    ).toHaveCount(0)
    await closeMenus(orcaPage)

    await openGroupActions(orcaPage, childId!, 'Child')
    await openMoveSubmenu(orcaPage)
    await expect(orcaPage.getByRole('menuitem', { name: 'Top level', exact: true })).toBeEnabled()
    await expect(moveTarget(orcaPage, rootId!)).toBeDisabled()
    await expect(moveTarget(orcaPage, otherId!)).toBeEnabled()
    for (const hiddenId of [childId!, grandchildId!]) {
      await expect(moveTarget(orcaPage, hiddenId)).toHaveCount(0)
    }
    await closeMenus(orcaPage)

    // An unrelated group can move into that subtree, but not below the third level.
    await openGroupActions(orcaPage, otherId!, 'Other')
    await openMoveSubmenu(orcaPage)
    for (const targetId of [rootId!, childId!]) {
      await expect(moveTarget(orcaPage, targetId)).toBeEnabled()
    }
    await expect(moveTarget(orcaPage, grandchildId!)).toHaveCount(0)
    await orcaPage.screenshot({
      path: testInfo.outputPath('move-targets.png'),
      animations: 'disabled'
    })
  })
})
