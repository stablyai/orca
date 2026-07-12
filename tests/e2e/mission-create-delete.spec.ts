import { existsSync, lstatSync, readdirSync } from 'node:fs'
import { test, expect } from './helpers/orca-app'

test.describe('Missions', () => {
  test('creates a mission with a member worktree and deletes it', async ({ orcaPage }) => {
    // Switch to the Missions tab in the sidebar header.
    await orcaPage.getByRole('button', { name: 'Missions', exact: true }).click()
    await expect(orcaPage.getByText('No missions yet')).toBeVisible()

    // Open the create dialog from the empty state.
    await orcaPage.getByRole('button', { name: 'New Mission' }).first().click()
    await orcaPage.getByLabel('Mission Name').fill('Referral')
    // Select the seeded repo via the sticky "All projects" row.
    await orcaPage.getByRole('combobox').click()
    await orcaPage.getByText('All projects', { exact: true }).click()
    await orcaPage.keyboard.press('Escape')
    // Why: mission worktree creation runs real git worktree add under the hood.
    await orcaPage.getByRole('button', { name: 'Create Mission' }).click({ timeout: 10_000 })

    // Mission header and its member worktree card appear (DOM assertions).
    const missionHeader = orcaPage.locator('[data-mission-id]').filter({ hasText: 'Referral' })
    await expect(missionHeader).toBeVisible({ timeout: 60_000 })
    await expect(orcaPage.getByText('Workspace missing')).not.toBeVisible()

    // The member worktree exists in the store on the mission branch.
    const memberWorktreeId = await orcaPage.evaluate(() => {
      const store = window.__store
      if (!store) {
        throw new Error('Expected e2e store to be exposed')
      }
      return store.getState().missions[0]?.members[0]?.worktreeId ?? null
    })
    expect(memberWorktreeId).toBeTruthy()

    // The mission session is created eagerly with the mission: the symlinked
    // root and the mission-owned folder workspace exist without extra clicks.
    await expect
      .poll(
        () =>
          orcaPage.evaluate(() => {
            const store = window.__store
            if (!store) {
              throw new Error('Expected e2e store to be exposed')
            }
            const workspace = store.getState().folderWorkspaces.find((fw) => fw.missionId)
            return workspace?.folderPath ?? ''
          }),
        { timeout: 30_000 }
      )
      .toContain('missions')
    const missionRoot = await orcaPage.evaluate(
      () => window.__store!.getState().folderWorkspaces.find((fw) => fw.missionId)!.folderPath
    )
    // The root physically contains a symlink to the member worktree.
    const rootEntries = readdirSync(missionRoot)
    expect(rootEntries.length).toBeGreaterThan(0)
    expect(lstatSync(`${missionRoot}/${rootEntries[0]}`).isSymbolicLink()).toBe(true)

    // Delete the mission including its worktree via the header menu.
    await missionHeader.hover()
    await missionHeader.getByRole('button', { name: 'Mission options' }).click()
    await orcaPage.getByRole('menuitem', { name: 'Delete mission' }).click()
    await orcaPage.getByRole('button', { name: 'Delete', exact: true }).click()

    await expect(orcaPage.getByText('No missions yet')).toBeVisible({ timeout: 60_000 })
    // Mission delete removes the symlinked root as well.
    expect(existsSync(missionRoot)).toBe(false)
    const missionCount = await orcaPage.evaluate(() => {
      const store = window.__store
      if (!store) {
        throw new Error('Expected e2e store to be exposed')
      }
      return store.getState().missions.length
    })
    expect(missionCount).toBe(0)
  })
})
