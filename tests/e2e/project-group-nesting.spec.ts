import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

test.describe('Project Group manual nesting @headful', () => {
  test('creates a subgroup and filters invalid parent targets', async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    const groups = await orcaPage.evaluate(async () => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      store.getState().setGroupBy('repo')
      const parent = await store.getState().createProjectGroup('E2E Parent')
      const sibling = await store.getState().createProjectGroup('E2E Sibling')
      if (!parent || !sibling) {
        throw new Error('Failed to create project groups')
      }
      return { parentId: parent.id, siblingId: sibling.id }
    })

    const parentHeader = orcaPage.locator(`[data-project-group-header-id="${groups.parentId}"]`)
    await expect(parentHeader).toBeVisible()
    await parentHeader.getByRole('button', { name: /Group actions for E2E Parent/ }).click()
    await orcaPage.getByRole('menuitem', { name: 'New subgroup' }).click()
    await orcaPage.getByRole('textbox').fill('E2E Child')
    await orcaPage.getByRole('button', { name: 'Create' }).click()

    await expect
      .poll(() =>
        orcaPage.evaluate(
          () =>
            window.__store?.getState().projectGroups.find((group) => group.name === 'E2E Child')
              ?.parentGroupId
        )
      )
      .toBe(groups.parentId)

    const childId = await orcaPage.evaluate(() => {
      const child = window.__store
        ?.getState()
        .projectGroups.find((group) => group.name === 'E2E Child')
      if (!child) {
        throw new Error('E2E Child was not persisted')
      }
      return child.id
    })
    const childHeader = orcaPage.locator(`[data-project-group-header-id="${childId}"]`)
    await expect(childHeader).toBeVisible()

    await parentHeader.getByRole('button', { name: /Group actions for E2E Parent/ }).click()
    await orcaPage.getByRole('menuitem', { name: 'Move to group' }).hover()
    await expect(orcaPage.getByRole('menuitem', { name: 'E2E Parent' })).toHaveCount(0)
    await expect(orcaPage.getByRole('menuitem', { name: 'E2E Child' })).toHaveCount(0)
    await expect(orcaPage.getByRole('menuitem', { name: 'E2E Sibling' })).toBeVisible()
    await orcaPage.getByRole('menuitem', { name: 'E2E Sibling', exact: true }).click()

    await expect
      .poll(() =>
        orcaPage.evaluate(
          (id) =>
            window.__store?.getState().projectGroups.find((group) => group.id === id)
              ?.parentGroupId,
          groups.parentId
        )
      )
      .toBe(groups.siblingId)

    await parentHeader.getByRole('button', { name: /Group actions for E2E Parent/ }).click()
    await orcaPage.getByRole('menuitem', { name: 'Move to root', exact: true }).click()
    await expect
      .poll(() =>
        orcaPage.evaluate(
          (id) =>
            window.__store?.getState().projectGroups.find((group) => group.id === id)
              ?.parentGroupId,
          groups.parentId
        )
      )
      .toBeNull()

    await expect(parentHeader).toBeVisible()
    await expect(childHeader).toBeVisible()
    const parentPadding = await parentHeader.evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).paddingLeft)
    )
    const childPadding = await childHeader.evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).paddingLeft)
    )
    expect(childPadding).toBeGreaterThan(parentPadding)
  })
})
