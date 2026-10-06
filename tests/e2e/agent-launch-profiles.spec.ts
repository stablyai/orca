// Exercise actual management IPC and terminal launch against disposable provider homes.
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect } from './helpers/orca-app'
import {
  test,
  prepareProfileHome,
  openAgentSettings,
  profileSection,
  chooseProfileFolder,
  captureProfileWindow
} from './helpers/agent-profile-fixture'
import { getTerminalContent, waitForTerminalOutput } from './helpers/terminal'

test.skip(process.platform === 'win32', 'Profiles currently support native macOS/Linux only')

for (const theme of ['light', 'dark'] as const) {
  test(`connects Claude and Codex profiles through real IPC (${theme})`, async ({
    orcaPage: page,
    electronApp,
    profileRoot
  }, info) => {
    // Four live provider terminals and two connection flows share one isolated app.
    test.setTimeout(300_000)
    await prepareProfileHome(electronApp, profileRoot)
    await page.setViewportSize({ width: 1440, height: 1000 })
    if (theme === 'dark') {
      const folderPath = join(profileRoot, 'folder-workspace')
      mkdirSync(folderPath)
      await page.evaluate(async (folderPath) => {
        const state = window.__store!.getState()
        const group = await window.api.projectGroups.create({
          name: 'Profile folder project',
          parentPath: folderPath,
          createdFrom: 'folder-scan'
        })
        await state.fetchProjectGroups()
        const folder = await state.createFolderWorkspace({
          projectGroupId: group.id,
          name: 'Profile folder workspace',
          folderPath
        })
        if (!folder) {
          throw new Error('Synthetic folder workspace was not created')
        }
        state.setActiveWorktree(`folder:${folder.id}`)
      }, folderPath)
    }
    await openAgentSettings(page, theme)
    await expect(page.getByRole('button', { name: 'Add profile', exact: true })).toHaveCount(2)
    await profileSection(page, 'claude').scrollIntoViewIfNeeded()
    await captureProfileWindow(page, info, `agents-before-${theme}`)
    for (const agent of ['claude', 'codex'] as const) {
      await prepareProfileHome(electronApp, profileRoot)
      const section = profileSection(page, agent)
      await section.getByRole('button', { name: 'Add profile', exact: true }).click()
      await expect(page.getByRole('button', { name: 'Save profile', exact: true })).toBeDisabled()
      await expect(
        page.getByRole('button', { name: 'Sign in to another account', exact: true })
      ).toBeVisible()
      await page.getByLabel('Profile name', { exact: true }).fill(`${agent} A`)
      await page.getByRole('radio', { name: 'Connect existing', exact: true }).click()
      await page.getByLabel('Command or alias', { exact: true }).fill('missing_profile')
      await page.getByRole('button', { name: 'Check connection', exact: true }).click()
      await expect(page.getByRole('alert')).toContainText(/folder/i)
      await captureProfileWindow(page, info, `${agent}-fallback-${theme}`)
      await page.getByLabel('Command or alias', { exact: true }).fill('unsupported_profile')
      await page.getByRole('button', { name: 'Check connection', exact: true }).click()
      await expect(page.getByRole('alert')).toContainText(/folder/i)
      // Literal discovery refuses shell control flow; use a provable alias-only source next.
      await prepareProfileHome(electronApp, profileRoot, 'literal')
      await chooseProfileFolder(electronApp, page, join(profileRoot, `${agent}-a`))
      await page.getByRole('button', { name: 'Check connection', exact: true }).click()
      await expect(
        page.getByRole('status').filter({ hasText: 'Starts a new terminal' })
      ).toContainText(join(profileRoot, `${agent}-a`))
      await page.getByRole('button', { name: 'Save profile', exact: true }).scrollIntoViewIfNeeded()
      await expect(page.getByRole('button', { name: 'Save profile', exact: true })).toBeInViewport()
      await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeInViewport()
      await captureProfileWindow(page, info, `${agent}-preview-${theme}`)
      await page.getByRole('button', { name: 'Save profile', exact: true }).click()
      await expect(section.getByText(`${agent} A`, { exact: true })).toBeVisible()
      await section.getByRole('button', { name: 'Add profile', exact: true }).click()
      await page.getByLabel('Profile name', { exact: true }).fill(`${agent} B`)
      await page.getByRole('radio', { name: 'Connect existing', exact: true }).click()
      await page.getByLabel('Command or alias', { exact: true }).fill(`${agent}_profile`)
      await page.getByRole('button', { name: 'Check connection', exact: true }).click()
      await expect(
        page.getByRole('status').filter({ hasText: 'Starts a new terminal' })
      ).toContainText(join(profileRoot, `${agent}-b`))
      await page.getByRole('button', { name: 'Save profile', exact: true }).click()
      await expect(section.getByText(`${agent} B`, { exact: true })).toBeVisible()
    }
    await profileSection(page, 'claude')
      .getByRole('button', { name: 'Add profile', exact: true })
      .click()
    await page.getByRole('radio', { name: 'Connect existing', exact: true }).click()
    await electronApp.evaluate(({ dialog }) => {
      dialog.showOpenDialog = async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 600))
        return { canceled: true, filePaths: [] }
      }
    })
    await page.getByRole('button', { name: 'Choose folder', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Choose folder', exact: true })).toBeDisabled()
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page.getByLabel('Profile name', { exact: true })).toHaveCount(0)
    await profileSection(page, 'claude').scrollIntoViewIfNeeded()
    await captureProfileWindow(page, info, `agents-after-${theme}`)
    await prepareProfileHome(electronApp, profileRoot, 'launch')
    await page.evaluate(() => window.__store!.getState().closeSettingsPage())
    await page.getByRole('button', { name: 'New tab', exact: true }).click()
    await expect(page.getByRole('menuitem', { name: 'Claude', exact: true })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Codex', exact: true })).toBeVisible()
    await captureProfileWindow(page, info, `quick-launch-${theme}`)
    await page.keyboard.press('Escape')
    for (const agent of ['claude', 'codex'] as const) {
      for (const account of ['A', 'B']) {
        await page.getByRole('button', { name: 'New tab', exact: true }).click()
        await page
          .getByRole('menuitem', {
            name: `${agent} ${account} Unverified configuration`,
            exact: true
          })
          .click()
        await waitForTerminalOutput(
          page,
          join(profileRoot, `${agent}-${account.toLowerCase()}`),
          25_000
        )
        const output = await getTerminalContent(page)
        expect(output).toContain('PROFILE_AGENT')
        expect(output).toContain(join(profileRoot, `${agent}-${account.toLowerCase()}`))
        expect(output).not.toContain('wrong-home')
      }
    }
    await openAgentSettings(page)
    const claude = profileSection(page, 'claude')
    const first = claude.getByRole('listitem').filter({ hasText: 'claude A' })
    await first.getByRole('button', { name: 'Edit', exact: true }).click()
    await page.getByLabel('Profile name', { exact: true }).fill('Claude renamed')
    await chooseProfileFolder(electronApp, page, join(profileRoot, 'claude-c'))
    await page.getByRole('button', { name: 'Check connection', exact: true }).click()
    await page.getByRole('button', { name: 'Save profile', exact: true }).click()
    await expect(claude.getByText('Claude renamed', { exact: true })).toBeVisible()
    await expect(claude.getByText(/claude-c/)).toBeVisible()
    await claude
      .getByRole('listitem')
      .filter({ hasText: 'Claude renamed' })
      .getByRole('button', { name: 'Unlink', exact: true })
      .click()
    await expect(claude.getByText('Claude renamed', { exact: true })).toHaveCount(0)
    expect(existsSync(join(profileRoot, 'claude-a'))).toBe(true)
    expect(existsSync(join(profileRoot, 'claude-c'))).toBe(true)
    await page.evaluate(() => window.__store!.getState().closeSettingsPage())
    await page.locator('[data-testid="sortable-tab"][data-tab-title="claude A"]').click()
    expect(await getTerminalContent(page)).toContain(join(profileRoot, 'claude-a'))
  })
}
