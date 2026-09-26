import { randomUUID } from 'node:crypto'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { buildFakeAgentCommandOverride } from './helpers/fake-agent-command-override'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { getTerminalContent } from './helpers/terminal'

// Covers the per-project Claude account: settings, the launch prompt, pinned launches and refusals.

const SCREENSHOT_DIR = process.env.ORCA_PER_PROJECT_CLAUDE_ACCOUNT_SCREENSHOT_DIR
const FIXTURE_DIR = path.join(
  process.cwd(),
  'tests',
  'e2e',
  'fixtures',
  'per-project-claude-account'
)
// Absolute so the launch never resolves a developer's real `claude` from the terminal's PATH.
const STAND_IN_CLAUDE = path.join(FIXTURE_DIR, 'claude')
const READY_PATTERN = /FAKE_CLAUDE_READY CLAUDE_CONFIG_DIR=\[([^\]]*)\]/
const MISSING_ACCOUNT_ID = '00000000-dead-4bad-8bad-000000000000'
const WORK = { id: randomUUID(), email: 'work@example.test', organizationName: 'Work Org' }
const PERSONAL = { id: randomUUID(), email: 'personal@example.test', organizationName: null }

test.use({
  launchEnv: { PATH: [FIXTURE_DIR, process.env.PATH ?? ''].join(path.delimiter) }
})

async function saveScreenshot(page: Page, name: string): Promise<void> {
  if (!SCREENSHOT_DIR) {
    return
  }
  mkdirSync(SCREENSHOT_DIR, { recursive: true })
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${name}.png`) })
}

function writeManagedAuthDir(userDataDir: string, account: typeof WORK | typeof PERSONAL): string {
  const authDir = path.join(userDataDir, 'claude-accounts', account.id, 'auth')
  mkdirSync(authDir, { recursive: true, mode: 0o700 })
  writeFileSync(path.join(authDir, '.orca-managed-claude-auth'), `${account.id}\n`)
  writeFileSync(
    path.join(authDir, '.credentials.json'),
    JSON.stringify({
      claudeAiOauth: {
        email: account.email,
        accessToken: `fake-access-${account.id}`,
        refreshToken: `fake-refresh-${account.id}`,
        // Far future so nothing attempts an OAuth refresh with the fake token.
        expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000
      }
    })
  )
  writeFileSync(
    path.join(authDir, 'oauth-account.json'),
    `${JSON.stringify({ accountUuid: account.id, emailAddress: account.email })}\n`
  )
  return realpathSync(authDir)
}

async function startClaudeFromTabBar(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'New tab' }).click({ force: true })
  const option = page.getByRole('menuitem', { name: /^Claude(?:\s|$)/i }).first()
  await expect(option).toBeVisible({ timeout: 15_000 })
  await option.click({ force: true })
}

function activeTabId(page: Page): Promise<string | null> {
  return page.evaluate(() => window.__store!.getState().activeTabId ?? null)
}

function tabPtyIds(page: Page, tabId: string | null): Promise<string[]> {
  return page.evaluate(
    (id) => (id ? (window.__store!.getState().ptyIdsByTabId[id] ?? []) : []),
    tabId
  )
}

async function waitForLaunchedConfigDir(page: Page, previousTabId: string | null): Promise<string> {
  await expect.poll(() => activeTabId(page), { timeout: 15_000 }).not.toBe(previousTabId)
  return waitForConfigDirOutput(page)
}

async function waitForConfigDirOutput(page: Page): Promise<string> {
  let match: RegExpMatchArray | null = null
  await expect
    .poll(
      async () => {
        match = (await getTerminalContent(page)).match(READY_PATTERN)
        return match !== null
      },
      { timeout: 30_000, message: 'stand-in claude never reported its config dir' }
    )
    .toBe(true)
  return match?.[1] ?? ''
}

async function openRepoClaudeAccountSetting(page: Page, repoId: string) {
  await page.evaluate((id) => {
    const state = window.__store!.getState()
    state.setSettingsSearchQuery('')
    state.openSettingsTarget({ pane: 'repo', repoId: id })
    state.openSettingsPage()
  }, repoId)
  const section = page
    .locator('div.scroll-mt-6')
    .filter({ hasText: 'Choose which Claude account starts in this project.' })
    .last()
  await expect(section).toBeVisible({ timeout: 15_000 })
  await section.scrollIntoViewIfNeeded()
  return section
}

async function closeSettings(page: Page): Promise<void> {
  await page.evaluate(() => window.__store!.getState().closeSettingsPage())
}

test.describe('Per-project Claude account', () => {
  test.skip(
    process.platform === 'darwin',
    'macOS keeps managed Claude credentials in the login Keychain, which the e2e harness does not isolate'
  )
  test.skip(
    process.platform === 'win32',
    'The stand-in claude is a POSIX script; Windows launches are not covered here'
  )

  test('pins launches to the saved account and explains a missing one', async ({
    orcaPage,
    electronApp
  }) => {
    test.setTimeout(180_000)
    await waitForSessionReady(orcaPage)
    const worktreeId = await waitForActiveWorktree(orcaPage)

    const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
    const managedAccounts = [WORK, PERSONAL].map((account) => ({
      id: account.id,
      email: account.email,
      managedAuthPath: writeManagedAuthDir(userDataDir, account),
      managedAuthRuntime: 'host' as const,
      authMethod: 'subscription-oauth' as const,
      organizationUuid: null,
      organizationName: account.organizationName,
      createdAt: 1,
      updatedAt: 1,
      lastAuthenticatedAt: Date.now()
    }))
    const personalAuthDir = managedAccounts[1].managedAuthPath
    const repoId = await orcaPage.evaluate(
      async ({ accounts, override, id }) => {
        const state = window.__store!.getState()
        await state.updateSettings({
          claudeManagedAccounts: accounts,
          activeClaudeManagedAccountId: null,
          agentCmdOverrides: { claude: override }
        })
        return (
          state.repos.find((repo) =>
            (state.worktreesByRepo[repo.id] ?? []).some((worktree) => worktree.id === id)
          )?.id ?? null
        )
      },
      {
        accounts: managedAccounts,
        override: buildFakeAgentCommandOverride(STAND_IN_CLAUDE),
        id: worktreeId
      }
    )
    expect(repoId).toBeTruthy()
    const projectId = repoId ?? ''

    await test.step('repository settings list the account choices', async () => {
      const section = await openRepoClaudeAccountSetting(orcaPage, projectId)
      await saveScreenshot(orcaPage, 'a1-settings-repository-claude-account-default')
      await section.getByRole('combobox').click()
      const options = orcaPage.getByRole('listbox').getByRole('option')
      await expect(options).toHaveText([
        'Default',
        'Ask every time',
        `${WORK.email} · ${WORK.organizationName}`,
        PERSONAL.email
      ])
      await saveScreenshot(orcaPage, 'a1-settings-repository-claude-account-options')
      await options.filter({ hasText: 'Ask every time' }).click()
      await expect
        .poll(() =>
          orcaPage.evaluate(
            (id) => window.__store!.getState().repos.find((repo) => repo.id === id)?.agentAccounts,
            projectId
          )
        )
        .toEqual({ claude: { mode: 'ask' } })
      await closeSettings(orcaPage)
    })

    const prompt = orcaPage.getByRole('dialog', { name: 'Choose a Claude account' })
    await test.step('Ask prompts, and Remember pins the chosen account', async () => {
      await startClaudeFromTabBar(orcaPage)
      await expect(prompt).toBeVisible({ timeout: 15_000 })
      await expect(prompt.getByRole('checkbox')).toHaveAttribute('data-state', 'checked')
      await prompt.getByRole('combobox').click()
      await orcaPage.getByRole('option', { name: PERSONAL.email }).click()
      await expect(orcaPage.getByRole('listbox')).toBeHidden()
      await expect(prompt.getByRole('combobox')).toContainText(PERSONAL.email)
      await saveScreenshot(orcaPage, 'b-choose-claude-account-prompt')
      const before = await activeTabId(orcaPage)
      await prompt.getByRole('button', { name: 'Start' }).click()
      await expect(prompt).toBeHidden()

      expect(await waitForLaunchedConfigDir(orcaPage, before)).toBe(personalAuthDir)
      await saveScreenshot(orcaPage, 'c-pinned-claude-terminal-output')
      const saved = await orcaPage.evaluate(
        (id) => window.__store!.getState().repos.find((repo) => repo.id === id)?.agentAccounts,
        projectId
      )
      expect(saved).toEqual({ claude: { mode: 'account', accountId: PERSONAL.id } })
      const section = await openRepoClaudeAccountSetting(orcaPage, projectId)
      await expect(section.getByRole('combobox')).toContainText(PERSONAL.email)
      await saveScreenshot(orcaPage, 'c-settings-repository-shows-personal')
      await closeSettings(orcaPage)
    })

    await test.step('the next launch reuses the account without prompting', async () => {
      const before = await activeTabId(orcaPage)
      await startClaudeFromTabBar(orcaPage)
      expect(await waitForLaunchedConfigDir(orcaPage, before)).toBe(personalAuthDir)
      await expect(prompt).toBeHidden()

      const trigger = orcaPage
        .locator('[data-testid="sortable-tab"][data-active="true"] [data-slot="tooltip-trigger"]')
        .first()
      const tooltip = orcaPage.locator('[data-slot="tooltip-content"]').first()
      // Radix opens only on a pointermove it receives; the account roster loads on first open.
      const hoverTab = async (): Promise<void> => {
        await trigger.hover({ position: { x: 10, y: 6 } })
        await orcaPage.waitForTimeout(250)
        await trigger.hover({ position: { x: 30, y: 6 } })
      }
      await hoverTab()
      await expect(tooltip).toBeVisible({ timeout: 10_000 })
      await orcaPage.mouse.move(600, 600)
      await orcaPage.waitForTimeout(600)
      await hoverTab()
      await expect(tooltip).toContainText(` · ${PERSONAL.email}`, { timeout: 10_000 })
      await saveScreenshot(orcaPage, 'd-tab-tooltip-pinned-account')
      await orcaPage.mouse.move(600, 600)
    })

    await test.step('a missing account is refused and can start on the active one', async () => {
      await orcaPage.evaluate(
        ({ id, missing }) =>
          window.__store!.getState().updateRepo(id, {
            agentAccounts: { claude: { mode: 'account', accountId: missing } }
          }),
        { id: projectId, missing: MISSING_ACCOUNT_ID }
      )
      const before = await activeTabId(orcaPage)
      await startClaudeFromTabBar(orcaPage)
      await expect.poll(() => activeTabId(orcaPage), { timeout: 15_000 }).not.toBe(before)
      const refusedTabId = await activeTabId(orcaPage)
      const refusalMessage = 'The saved Claude account for this project is no longer signed in.'
      await expect(orcaPage.getByText(refusalMessage, { exact: false })).toBeVisible({
        timeout: 30_000
      })
      const startOnActive = orcaPage.getByRole('button', { name: 'Start on active account' })
      await expect(startOnActive).toBeVisible()
      await saveScreenshot(orcaPage, 'e1-refusal-toast-account-missing')

      const refusedPtyIds = await tabPtyIds(orcaPage, refusedTabId)
      await startOnActive.click()
      // The refused pane restarts in place: same tab, a fresh PTY, on the active account.
      await expect
        .poll(
          async () =>
            (await tabPtyIds(orcaPage, refusedTabId)).some((id) => !refusedPtyIds.includes(id)),
          { timeout: 15_000, message: 'refused pane never got a new PTY' }
        )
        .toBe(true)
      expect(await activeTabId(orcaPage)).toBe(refusedTabId)
      const configDir = await waitForConfigDirOutput(orcaPage)
      expect(configDir.startsWith(realpathSync(path.join(userDataDir, 'claude-accounts')))).toBe(
        false
      )
      await expect(startOnActive).toBeHidden()
      await expect(orcaPage.getByText(refusalMessage, { exact: false })).toBeHidden()
      await saveScreenshot(orcaPage, 'e2-started-on-active-account')
    })
  })
})
