import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'

const OUT_DIR = path.join(process.cwd(), 'docs', 'superpowers', 'evidence', 'missions')

test.describe('Mission screenshots', () => {
  test('captures review evidence in light and dark themes', async ({ orcaPage }) => {
    test.setTimeout(240_000)
    mkdirSync(OUT_DIR, { recursive: true })

    const shot = (name: string) => orcaPage.screenshot({ path: path.join(OUT_DIR, `${name}.png`) })

    const setTheme = async (theme: 'light' | 'dark') => {
      await orcaPage.evaluate(async (nextTheme) => {
        const store = window.__store
        if (!store) {
          throw new Error('Expected e2e store to be exposed')
        }
        await store.getState().updateSettings({ theme: nextTheme })
      }, theme)
      await orcaPage.waitForTimeout(500)
    }

    const createMission = async (missionName: string, screenshotName?: string) => {
      await orcaPage.getByRole('button', { name: 'New Mission' }).first().click()
      await orcaPage.getByLabel('Mission Name').fill(missionName)
      await orcaPage.locator('[role="combobox"]:not([data-agent-combobox-root])').click()
      await orcaPage.getByText('All projects', { exact: true }).click()
      await orcaPage.keyboard.press('Escape')
      if (screenshotName) {
        await shot(screenshotName)
      }
      await orcaPage.getByRole('button', { name: 'Create Mission' }).click()
      const header = orcaPage.locator('[data-mission-id]').filter({ hasText: missionName }).first()
      await expect(header).toBeVisible({ timeout: 60_000 })
      return header
    }

    for (const theme of ['light', 'dark'] as const) {
      await setTheme(theme)
      const missionName = theme === 'light' ? 'Referral' : 'Referral Dark'

      // (2) Create dialog with members picked, then two missions so the
      // mission-list screenshot shows two expanded missions (spec UI Quality Bar).
      await orcaPage.getByRole('button', { name: 'Missions', exact: true }).click()
      const missionHeader = await createMission(missionName, `create-dialog-${theme}`)
      await createMission(`${missionName} Demo`)

      // (1) Missions tab with two missions expanded (spec UI Quality Bar):
      // both headers report aria-expanded and member cards are visible.
      const expandedHeaders = orcaPage.locator('[data-mission-id] button[aria-expanded="true"]')
      await expect(expandedHeaders.nth(1)).toBeVisible({ timeout: 30_000 })
      expect(await expandedHeaders.count()).toBeGreaterThanOrEqual(2)
      await orcaPage.waitForTimeout(700)
      await shot(`mission-list-${theme}`)

      // (3) Per-member failure state: an invalid git ref fails deterministically
      // in resolveCreateBranchName (git check-ref-format).
      await orcaPage.getByRole('button', { name: 'New Mission' }).first().click()
      await orcaPage.getByLabel('Mission Name').fill(`${missionName} Failing`)
      await orcaPage.getByLabel('Branch').fill('mission/bad..ref')
      await orcaPage.locator('[role="combobox"]:not([data-agent-combobox-root])').click()
      await orcaPage.getByText('All projects', { exact: true }).click()
      await orcaPage.keyboard.press('Escape')
      await orcaPage.getByRole('button', { name: 'Create Mission' }).click()
      await expect(
        orcaPage.getByText('Some workspaces could not be created', { exact: false })
      ).toBeVisible({
        timeout: 60_000
      })
      await shot(`create-partial-failure-${theme}`)
      await orcaPage.getByRole('button', { name: 'Done', exact: true }).click()

      // (4) Delete confirmation dialog.
      await missionHeader.hover()
      await missionHeader.getByRole('button', { name: 'Mission options' }).click()
      await orcaPage.getByRole('menuitem', { name: 'Delete mission' }).click()
      await expect(orcaPage.getByText('Also delete member workspaces')).toBeVisible()
      await shot(`delete-dialog-${theme}`)
      await orcaPage.getByRole('button', { name: 'Cancel', exact: true }).click()

      // (5) Projects view with the mission badge on the member worktree card.
      await orcaPage.getByRole('button', { name: 'Projects', exact: true }).first().click()
      await orcaPage.waitForTimeout(700)
      await shot(`projects-view-badge-${theme}`)
    }
  })
})
