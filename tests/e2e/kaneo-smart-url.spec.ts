import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { KANEO_TASK as TASK, installKaneoApiFixture } from './helpers/kaneo-api-fixture'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.evaluate(async (theme) => {
    await window.__store?.getState().updateSettings({ theme, defaultTuiAgent: 'blank' })
  }, theme)
  await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /dark/ : /light/)
}

test.afterEach(async ({ orcaPage }) => {
  await orcaPage.evaluate(() => window.api.kaneo.disconnect())
})

for (const theme of ['light', 'dark'] as const) {
  for (const urlForm of ['task', 'board'] as const) {
    test(`Kaneo Smart URL resolves after retry and persists on creation (${theme}, ${urlForm})`, async ({
      electronApp,
      orcaPage
    }, testInfo) => {
      await waitForSessionReady(orcaPage)
      await waitForActiveWorktree(orcaPage)
      const originalIds = await orcaPage.evaluate(() =>
        window
          .__store!.getState()
          .allWorktrees()
          .map((item) => item.id)
      )
      try {
        await installKaneoApiFixture(electronApp)
        await orcaPage.evaluate(
          (siteUrl) => window.api.kaneo.connect({ siteUrl, apiKey: 'fixture-api-key' }),
          TASK.siteUrl
        )
        await setTheme(orcaPage, theme)
        await orcaPage.getByRole('button', { name: 'New workspace', exact: true }).click()
        const dialog = orcaPage.getByRole('dialog', { name: /Create (Workspace|Worktree)/i })
        const input = dialog.locator('[data-workspace-name-input="true"]')
        const create = dialog.getByRole('button', { name: /Create (Workspace|Worktree)/i })
        const taskUrl =
          urlForm === 'task'
            ? TASK.url
            : `${TASK.siteUrl}/dashboard/workspace/${TASK.workspaceId}/project/${TASK.projectId}/board?taskId=${TASK.taskId}`
        await input.fill(taskUrl)
        await expect(
          orcaPage.getByRole('status').filter({ hasText: 'Loading Kaneo task' })
        ).toBeVisible()
        await expect(create).toBeDisabled()
        await input.press('Enter')
        await expect(dialog).toBeVisible()
        await testInfo.attach(`kaneo-loading-${theme}.png`, {
          body: await orcaPage.screenshot(),
          contentType: 'image/png'
        })
        await expect(
          orcaPage.getByRole('status').filter({ hasText: 'rate limiting' })
        ).toBeVisible()
        await expect(create).toBeDisabled()
        await testInfo.attach(`kaneo-error-${theme}.png`, {
          body: await orcaPage.screenshot(),
          contentType: 'image/png'
        })
        await orcaPage.getByRole('button', { name: 'Retry', exact: true }).click()
        const option = orcaPage.getByRole('option').filter({ hasText: TASK.title })
        await expect(option).toBeVisible()
        await testInfo.attach(`kaneo-resolved-${theme}.png`, {
          body: await orcaPage.screenshot(),
          contentType: 'image/png'
        })
        await input.press('Enter')
        await expect(dialog.getByText(`#42 ${TASK.title}`, { exact: true })).toBeVisible()
        await expect(create).toBeEnabled()
        await testInfo.attach(`kaneo-selected-${theme}.png`, {
          body: await orcaPage.screenshot(),
          contentType: 'image/png'
        })
        let createdId: string | null = null
        await create.click()
        await expect
          .poll(
            async () => {
              createdId = await orcaPage.evaluate(
                (ids) =>
                  window
                    .__store!.getState()
                    .allWorktrees()
                    .find(
                      (item) => !ids.includes(item.id) && item.linkedWorkItem?.provider === 'kaneo'
                    )?.id ?? null,
                originalIds
              )
              return createdId
            },
            { timeout: 30_000 }
          )
          .not.toBeNull()
        await expect(dialog).toBeHidden({ timeout: 30_000 })
        await expect
          .poll(() => orcaPage.evaluate(() => window.__store!.getState().activeWorktreeId))
          .toBe(createdId)
        const linked = await orcaPage.evaluate((id) => {
          return window.__store
            ?.getState()
            .allWorktrees()
            .find((worktree) => worktree.id === id)?.linkedWorkItem
        }, createdId)
        expect(linked).toMatchObject({
          provider: 'kaneo',
          title: TASK.title,
          url: TASK.url,
          number: 42
        })
        const card = orcaPage
          .locator('[data-worktree-card-surface="true"]')
          .filter({ hasText: TASK.title })
        await expect(card).toBeVisible()
        for (const style of [
          { experimentalNewWorktreeCardStyle: false, compactWorktreeCards: false },
          { experimentalNewWorktreeCardStyle: false, compactWorktreeCards: true },
          { experimentalNewWorktreeCardStyle: true, compactWorktreeCards: false }
        ]) {
          await orcaPage.mouse.move(700, 100)
          await orcaPage.evaluate(async (style) => {
            await window.__store?.getState().updateSettings(style)
          }, style)
          await card.getByText(TASK.title, { exact: true }).hover()
          await expect(orcaPage.getByText('Kaneo #42', { exact: true })).toBeVisible()
          await expect(
            orcaPage.getByRole('button', { name: TASK.title, exact: true })
          ).toBeVisible()
        }
        await testInfo.attach(`kaneo-created-${theme}.png`, {
          body: await orcaPage.screenshot(),
          contentType: 'image/png'
        })
        expect(
          await electronApp.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows().every((window) => !window.isVisible())
          )
        ).toBe(true)
      } finally {
        await orcaPage.evaluate(async (ids) => {
          const state = window.__store!.getState()
          for (const item of state.allWorktrees()) {
            if (!ids.includes(item.id) && item.linkedWorkItem?.provider === 'kaneo') {
              await state.removeWorktree(
                { id: item.id, executionHostId: item.hostId ?? null },
                true
              )
            }
          }
        }, originalIds)
      }
    })
  }

  test(`Kaneo settings connect, clear secrets and disconnect (${theme})`, async ({
    electronApp,
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await installKaneoApiFixture(electronApp)
    await setTheme(orcaPage, theme)
    await orcaPage.evaluate(() => {
      const state = window.__store?.getState()
      state?.openSettingsTarget({ pane: 'integrations', repoId: null })
      state?.openSettingsPage()
    })
    const card = orcaPage.locator('[data-settings-section="kaneo-integration"]')
    await card.getByRole('button', { name: 'Connect Kaneo', exact: true }).click()
    await card.getByLabel('Instance URL', { exact: true }).fill(TASK.siteUrl)
    const key = card.getByLabel('API key', { exact: true })
    await key.fill('fixture-api-key')
    await expect(key).toHaveAttribute('type', 'password')
    await testInfo.attach(`kaneo-settings-${theme}.png`, {
      body: await card.screenshot(),
      contentType: 'image/png'
    })
    await card.getByRole('button', { name: 'Save connection', exact: true }).click()
    await expect(card.getByText('Connected', { exact: true })).toBeVisible()
    await card.getByRole('button', { name: 'Configure', exact: true }).click()
    await expect(key).toHaveValue('')
    await card.getByLabel('Instance URL', { exact: true }).fill('https://unsaved.example.com')
    await card.getByRole('button', { name: 'Cancel', exact: true }).click()
    await card.getByRole('button', { name: 'Configure', exact: true }).click()
    await expect(card.getByLabel('Instance URL', { exact: true })).toHaveValue(TASK.siteUrl)
    await card.getByRole('button', { name: 'Cancel', exact: true }).click()
    await card.getByRole('button', { name: 'Disconnect', exact: true }).click()
    await expect(card.getByText('Not connected', { exact: true })).toBeVisible()
  })
}
