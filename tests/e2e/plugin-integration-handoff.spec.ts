import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from './helpers/orca-app'
import { enableDevPlugins } from './helpers/plugin-smoke'
import { writeIntegrationHandoffFixture } from './helpers/plugin-integration-handoff-fixture'
import { configureGoldenStubAgent, getGoldenStubAgentLaunchEnv } from './helpers/golden-stub-agent'
import { getTerminalContent } from './helpers/terminal'

test.use({
  launchEnv: getGoldenStubAgentLaunchEnv(),
  orcaAppExtraEnv: { ORCA_PLUGIN_ISOLATED_FRAMES: '1' }
})

test('a plugin integration creates a stable code target and hands it to an explicitly selected installed Agent', async ({
  orcaPage: page,
  seededRepoPath,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  const root = await mkdtemp(join(tmpdir(), 'orca-plugin-handoff-'))
  registerPostElectronShutdownCleanup(() => rm(root, { recursive: true, force: true }))
  const pluginRoot = join(root, 'acme-tasks')
  await writeIntegrationHandoffFixture(pluginRoot)
  await configureGoldenStubAgent(page, { agent: 'codex', agentArgs: '--echo-launch-prompt' })
  await enableDevPlugins(page, [pluginRoot])

  await page.evaluate(async () => {
    await window.__store!.getState().updateSettings({ uiLanguage: 'en' })
    window.__store!.getState().openSettingsPage()
  })
  await page.getByRole('button', { name: 'Integrations', exact: true }).click()
  await page.getByRole('button', { name: 'Configure AcmeTasks', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: 'AcmeTasks connection', exact: true }).last()
  ).toBeVisible()
  await expect(page.getByText('Local synthetic provider', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Close settings', exact: true }).click()

  await page.evaluate(() => {
    const state = window.__store!.getState()
    if (!state.rightSidebarOpen) {
      state.toggleRightSidebar()
    }
  })
  await page.getByRole('button', { name: 'AcmeTasks', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Acme task 42', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'AcmeTasks connection', exact: true })).toHaveCount(
    0
  )
  await page.getByRole('button', { name: 'Connection settings', exact: true }).click()
  await expect(page.getByText('Local synthetic provider', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Close settings', exact: true }).click()

  await page.getByRole('combobox', { name: 'Code workspace', exact: true }).click()
  await page.getByRole('option', { name: seededRepoPath, exact: true }).click()
  const originalId = await page.getByText(/^Target ID: /).innerText()
  await expect(page.getByText(`Target path: ${seededRepoPath}`, { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Create code workspace', exact: true }).click()
  await expect(page.getByText(/^Target path: /)).toContainText('acme-plugin-handoff', {
    timeout: 30_000
  })
  const createdId = await page.getByText(/^Target ID: /).innerText()
  expect(createdId).not.toBe(originalId)
  expect(createdId).toMatch(/^Target ID: identity:/)
  const createdWorkspace = page
    .locator('[data-worktree-sidebar] [role="option"][data-worktree-id]')
    .filter({ hasText: 'acme-plugin-handoff' })
  await expect(createdWorkspace).not.toHaveAttribute('aria-current', 'page')
  await page.getByRole('button', { name: 'Open code workspace', exact: true }).click()
  await expect(createdWorkspace).toHaveAttribute('aria-current', 'page')
  await expect(page.getByText(createdId, { exact: true })).toBeVisible()
  await page.getByRole('combobox', { name: 'Installed Agent', exact: true }).click()
  await page.getByRole('option', { name: 'Codex', exact: true }).click()
  await page.getByRole('button', { name: 'Start selected Agent', exact: true }).click()
  await expect(page.getByText(/^Launched terminal: /)).toBeVisible({ timeout: 30_000 })
  await expect(async () => {
    await page.getByRole('button', { name: 'Read delivery', exact: true }).click()
    await expect(
      page.getByText('[GOLDEN_STUB_AGENT_SUBMITTED] ACME_TASK_42_IMPLEMENTATION_HANDOFF', {
        exact: false
      })
    ).toBeVisible({ timeout: 1_000 })
  }).toPass({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Open Agent terminal', exact: true }).click()
  await expect
    .poll(() => getTerminalContent(page, 20_000), { timeout: 30_000 })
    .toContain('[GOLDEN_STUB_AGENT_SUBMITTED] ACME_TASK_42_IMPLEMENTATION_HANDOFF')
  await page.screenshot({ path: testInfo.outputPath('plugin-agent-handoff.png') })

  await page.getByRole('button', { name: 'Connection settings', exact: true }).click()
  await page.getByRole('button', { name: 'Manage plugin', exact: true }).click()
  await page.getByRole('button', { name: 'More actions for AcmeTasks', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Remove development folder…', exact: true }).click()
  const remove = page.getByRole('dialog', {
    name: 'Remove development folder for AcmeTasks?',
    exact: true
  })
  await expect(remove).toBeVisible()
  await remove.getByRole('button', { name: 'Remove', exact: true }).click()
  await expect(remove).toHaveCount(0)
  await page.getByRole('button', { name: 'Integrations', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Configure AcmeTasks', exact: true })).toHaveCount(
    0
  )
  expect(JSON.parse(await readFile(join(pluginRoot, 'orca-plugin.json'), 'utf8')).id).toBe(
    'acme-tasks'
  )
})
