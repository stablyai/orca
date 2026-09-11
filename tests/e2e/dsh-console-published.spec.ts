import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import {
  buildAgentStartupPlan,
  buildAgentResumeStartupPlan
} from '../../src/shared/tui-agent-startup'
import {
  launchPublishedDshPlan,
  observeDshNotifications,
  readDshNotifications,
  submitDshInput
} from './helpers/dsh-console-published'
import path from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { expect, test } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { focusActiveTerminalInput, getTerminalContent } from './helpers/terminal'

// Opt-in: this exercises the npm-published CLI and a configured real model.
const root = process.env.ORCA_DSH_CONSOLE_ACCEPTANCE_ROOT
const launchEnv = root
  ? {
      PATH: [
        path.join(root, 'pinned-runtime/node_modules/.bin'),
        path.join(root, 'toolchain/node_modules/.bin'),
        process.env.PATH
      ].join(path.delimiter),
      DSH_HOME: path.join(root, 'dsh-home'),
      DSH_CONSOLE_SYSTEM_SETTINGS_PATH: path.join(root, 'console-settings.json'),
      DSH_TELEMETRY_DISABLED: '1'
    }
  : {}

test.use({ launchEnv })
test.skip(!root, 'Set ORCA_DSH_CONSOLE_ACCEPTANCE_ROOT to an isolated published-package fixture')

test('Escape leaves a running DSH tool active until Ctrl+C aborts it', async ({
  orcaPage
}, testInfo) => {
  test.setTimeout(120_000)
  await waitForSessionReady(orcaPage)
  const worktreeId = await waitForActiveWorktree(orcaPage)
  const plan = buildAgentStartupPlan({
    agent: 'dsh-console',
    prompt: 'Use bash to run sleep 30 in the foreground. Do not run it in the background.',
    cmdOverrides: {},
    platform: process.platform
  })!
  const tabId = await launchPublishedDshPlan(orcaPage, worktreeId, plan)
  const tab = orcaPage.locator(`[data-testid="sortable-tab"][data-tab-id="${tabId}"]`)
  await expect
    .poll(async () => stripVTControlCharacters(await getTerminalContent(orcaPage, 100_000)), {
      timeout: 30_000
    })
    .toMatch(/│\s*[⊶⊷]\s+sleep 30\s*│/)
  await focusActiveTerminalInput(orcaPage)
  await orcaPage.keyboard.press('Escape')
  // Let Orca's 500 ms key-inference window elapse before checking the native DSH behavior.
  await orcaPage.waitForTimeout(750)
  await expect(tab).toHaveAttribute('data-agent-activity-status', 'working')
  expect(stripVTControlCharacters(await getTerminalContent(orcaPage, 100_000))).toMatch(
    /│\s*[⊶⊷]\s+sleep 30\s*│/
  )
  await orcaPage.screenshot({ path: testInfo.outputPath('dsh-console-escape-working.png') })
  await orcaPage.keyboard.press('Control+c')
  await expect(tab).toHaveAttribute('data-agent-activity-status', 'interrupted', {
    timeout: 60_000
  })
  await expect
    .poll(async () => stripVTControlCharacters(await getTerminalContent(orcaPage, 100_000)))
    .toContain('Request cancelled.')
  await orcaPage.screenshot({ path: testInfo.outputPath('dsh-console-ctrl-c-interrupted.png') })
  await submitDshInput(orcaPage, '/quit')
  await expect(tab).not.toHaveAttribute('data-tab-title', /DSH Console/, { timeout: 15_000 })
})

test('published DSH Console launches from the menu and completes multiple turns', async ({
  orcaPage
}, testInfo) => {
  test.setTimeout(120_000)
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await orcaPage.evaluate(async () => {
    await window.__store!.getState().updateSettings({ defaultTuiAgent: 'dsh-console' })
  })
  await orcaPage
    .getByRole('button', { name: /^(New tab|新标签页|新建标签页)$/ })
    .click({ force: true })
  const option = orcaPage.getByRole('menuitem', { name: /^DSH Console(?:\s|$)/ }).first()
  await expect(option).toBeVisible({ timeout: 15_000 })
  await option.click({ force: true })
  await expect
    .poll(async () => stripVTControlCharacters(await getTerminalContent(orcaPage, 100_000)), {
      timeout: 30_000
    })
    .toContain('DSH CONSOLE')
  const tab = orcaPage.locator('[data-testid="sortable-tab"][data-active="true"]')
  await expect(tab).toHaveAttribute('data-tab-title', /DSH Console/i)
  for (const marker of ['ORCA_DSH_UI_FIRST', 'ORCA_DSH_UI_SECOND']) {
    await submitDshInput(orcaPage, `Reply with exactly ${marker}. Do not call any tools.`)
    await expect(tab).toHaveAttribute('data-agent-activity-status', 'done', { timeout: 30_000 })
    await expect
      .poll(async () => stripVTControlCharacters(await getTerminalContent(orcaPage, 100_000)), {
        timeout: 10_000
      })
      .toContain(`✦ ${marker}`)
  }
  await orcaPage.screenshot({ path: testInfo.outputPath('dsh-console-multiturn.png') })
})

test('folder and Git worktree initial prompts, exit and provider session resume', async ({
  orcaPage,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  test.setTimeout(180_000)
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  const folder = await realpath(await mkdtemp(path.join(tmpdir(), 'orca-dsh-folder-')))
  registerPostElectronShutdownCleanup(() => rm(folder, { recursive: true, force: true }))
  const worktreeId = await orcaPage.evaluate(() => {
    const state = window.__store!.getState()
    const worktree = Object.values(state.worktreesByRepo)
      .flat()
      .find((entry) => entry.branch.endsWith('e2e-secondary'))!
    state.setActiveWorktree(worktree.id)
    return worktree.id
  })
  const folderId = await orcaPage.evaluate(async (folderPath) => {
    const state = window.__store!.getState()
    const group = await state.createProjectGroup('DSH validation')
    const workspace = await state.createFolderWorkspace({
      projectGroupId: group!.id,
      name: 'DSH plain folder',
      folderPath
    })
    return workspace!.id
  }, folder)
  for (const scope of [
    { kind: 'worktree', id: worktreeId },
    { kind: 'folder', id: `folder:${folderId}` }
  ]) {
    await orcaPage.evaluate((scope) => {
      const state = window.__store!.getState()
      if (scope.kind === 'folder') {
        state.setActiveFolderWorkspace(scope.id.slice('folder:'.length))
      } else {
        state.setActiveWorktree(scope.id)
      }
    }, scope)
    const marker = `ORCA_DSH_${scope.kind.toUpperCase()}_INITIAL`
    const plan = buildAgentStartupPlan({
      agent: 'dsh-console',
      prompt: `Reply with exactly ${marker}. Do not call any tools.`,
      cmdOverrides: {},
      platform: process.platform
    })!
    const tabId = await launchPublishedDshPlan(orcaPage, scope.id, plan)
    const tab = orcaPage.locator(`[data-testid="sortable-tab"][data-tab-id="${tabId}"]`)
    await expect(tab).toHaveAttribute('data-agent-activity-status', 'done', { timeout: 30_000 })
    await expect
      .poll(async () => stripVTControlCharacters(await getTerminalContent(orcaPage, 100_000)))
      .toContain(`✦ ${marker}`)
    const providerSession = await orcaPage.evaluate(
      (tabId) =>
        Object.values(window.__store!.getState().agentStatusByPaneKey).find(
          (entry) => entry.tabId === tabId
        )?.providerSession,
      tabId
    )
    expect(providerSession?.id).toMatch(/^dsh-console-/)
    await orcaPage.screenshot({
      path: testInfo.outputPath(`dsh-console-${scope.kind}-initial.png`)
    })
    await focusActiveTerminalInput(orcaPage)
    await submitDshInput(orcaPage, '/quit')
    await expect(tab).not.toHaveAttribute('data-tab-title', /DSH Console/, { timeout: 15_000 })
    const resume = buildAgentResumeStartupPlan({
      agent: 'dsh-console',
      providerSession: providerSession!,
      cmdOverrides: {},
      platform: process.platform
    })!
    const resumedId = await launchPublishedDshPlan(orcaPage, scope.id, resume)
    await expect
      .poll(async () => stripVTControlCharacters(await getTerminalContent(orcaPage, 100_000)), {
        timeout: 30_000
      })
      .toContain(marker)
    await submitDshInput(
      orcaPage,
      `Reply with exactly ORCA_DSH_${scope.kind.toUpperCase()}_RESUMED. Do not call tools.`
    )
    const resumed = orcaPage.locator(`[data-testid="sortable-tab"][data-tab-id="${resumedId}"]`)
    await expect(resumed).toHaveAttribute('data-agent-activity-status', 'done', { timeout: 30_000 })
    await expect
      .poll(async () => stripVTControlCharacters(await getTerminalContent(orcaPage, 100_000)))
      .toContain(`✦ ORCA_DSH_${scope.kind.toUpperCase()}_RESUMED`)
    await orcaPage.screenshot({
      path: testInfo.outputPath(`dsh-console-${scope.kind}-resumed.png`)
    })
  }
})

test('real questions, approval, cancellation and notification dispatch', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  test.setTimeout(180_000)
  await waitForSessionReady(orcaPage)
  const worktreeId = await waitForActiveWorktree(orcaPage)
  await observeDshNotifications(electronApp)
  await orcaPage.evaluate(async () => {
    const state = window.__store!.getState()
    await state.updateSettings({
      notifications: {
        ...state.settings!.notifications,
        enabled: true,
        agentTaskComplete: true,
        suppressWhenFocused: false,
        customSoundVolume: 0
      }
    })
  })
  const plan = buildAgentStartupPlan({
    agent: 'dsh-console',
    prompt:
      'Use ask_user_question to ask which color I want, Blue or Green. After I select, reply with exactly ORCA_DSH_QUESTION_DONE.',
    cmdOverrides: {},
    platform: process.platform
  })!
  const tabId = await launchPublishedDshPlan(orcaPage, worktreeId, plan)
  const tab = orcaPage.locator(`[data-testid="sortable-tab"][data-tab-id="${tabId}"]`)
  await expect(tab).toHaveAttribute('data-agent-activity-status', 'permission', { timeout: 30_000 })
  await expect
    .poll(async () => stripVTControlCharacters(await getTerminalContent(orcaPage, 100_000)))
    .toContain('Blue')
  await orcaPage.screenshot({ path: testInfo.outputPath('dsh-console-question.png') })
  await focusActiveTerminalInput(orcaPage)
  await orcaPage.keyboard.press('Enter')
  await expect(tab).toHaveAttribute('data-agent-activity-status', 'done', { timeout: 30_000 })
  await expect
    .poll(async () => stripVTControlCharacters(await getTerminalContent(orcaPage, 100_000)))
    .toMatch(/(?:^|\n)\s*(?:✦ )?ORCA_DSH_QUESTION_DONE\s*(?:█)?\s*(?:\r?\n|$)/)
  await submitDshInput(orcaPage, '/permission read-only')
  await expect
    .poll(async () => stripVTControlCharacters(await getTerminalContent(orcaPage, 100_000)))
    .toContain('read-only')
  await submitDshInput(
    orcaPage,
    'Use bash to run exactly: printf approved > dsh-approval-marker.txt. This is a disposable test file. After success reply exactly ORCA_DSH_APPROVAL_DONE.'
  )
  await expect(tab).toHaveAttribute('data-agent-activity-status', 'permission', { timeout: 30_000 })
  await orcaPage.screenshot({ path: testInfo.outputPath('dsh-console-approval.png') })
  await orcaPage.keyboard.press('Enter')
  await expect(tab).toHaveAttribute('data-agent-activity-status', 'done', { timeout: 30_000 })
  await expect
    .poll(async () => stripVTControlCharacters(await getTerminalContent(orcaPage, 100_000)))
    .toMatch(/(?:^|\n)\s*(?:✦ )?ORCA_DSH_APPROVAL_DONE\s*(?:█)?\s*(?:\r?\n|$)/)
  await writeFile(
    testInfo.outputPath('dsh-console-notifications.json'),
    JSON.stringify(await readDshNotifications(electronApp), null, 2)
  )
  await submitDshInput(
    orcaPage,
    'Use bash to run sleep 30 in the foreground. Do not run it in the background.'
  )
  await expect(tab).toHaveAttribute('data-agent-activity-status', 'working', { timeout: 15_000 })
  await expect
    .poll(async () => stripVTControlCharacters(await getTerminalContent(orcaPage, 100_000)), {
      timeout: 30_000
    })
    .toMatch(/│\s*⊷\s+sleep 30\s*│/)
  await orcaPage.keyboard.press('Control+c')
  await expect
    .poll(async () => stripVTControlCharacters(await getTerminalContent(orcaPage, 100_000)))
    .toContain('Request cancelled.')
  await expect(tab).toHaveAttribute('data-agent-activity-status', 'interrupted', {
    timeout: 60_000
  })
  await orcaPage.screenshot({ path: testInfo.outputPath('dsh-console-cancelled.png') })
  const notifications = await readDshNotifications(electronApp)
  expect(notifications.some((entry) => entry.request.agentType === 'dsh-console')).toBe(true)
  await writeFile(
    testInfo.outputPath('dsh-console-notifications.json'),
    JSON.stringify(notifications, null, 2)
  )
  await submitDshInput(orcaPage, '/quit')
  await expect(tab).not.toHaveAttribute('data-tab-title', /DSH Console/, { timeout: 15_000 })
})
