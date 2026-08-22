/**
 * Exploratory first-class-agent pass for IBM Bob against the REAL `bob` binary.
 *
 * Why: Bob has no stub and needs a logged-in ~/.bob, so this spec is gated on
 * ORCA_E2E_REAL_BOB=1 and copies the developer's Bob profile into the isolated
 * HOME. It is a manual validation aid, not a CI gate.
 */
import { execSync } from 'node:child_process'
import { cpSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import {
  ensureTerminalVisible,
  waitForActiveWorktree,
  waitForSessionReady,
  getActiveWorktreeId,
  worktreeExists
} from './helpers/store'
import {
  focusActiveTerminalInput,
  getTerminalContent,
  waitForTerminalOutput
} from './helpers/terminal'

function resolveBobBinDir(): string | null {
  if (process.env.ORCA_E2E_BOB_PATH) {
    return path.dirname(process.env.ORCA_E2E_BOB_PATH)
  }
  try {
    const resolved = execSync(process.platform === 'win32' ? 'where bob' : 'command -v bob', {
      encoding: 'utf8'
    })
      .split(/\r?\n/)[0]
      ?.trim()
    return resolved ? path.dirname(resolved) : null
  } catch {
    return null
  }
}

const BOB_BIN_DIR = resolveBobBinDir()
const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH'

test.use({
  launchEnv: {
    [pathKey]: [BOB_BIN_DIR, process.env[pathKey] ?? ''].filter(Boolean).join(path.delimiter)
  }
})
test.skip(
  process.env.ORCA_E2E_REAL_BOB !== '1' || !BOB_BIN_DIR,
  'needs ORCA_E2E_REAL_BOB=1 and a real, logged-in Bob Shell install on PATH'
)

const BOB_COMPOSER_HINT = 'Build Anything'

async function seedBobProfile(homeDir: string): Promise<void> {
  const source = path.join(os.homedir(), '.bob')
  const target = path.join(homeDir, '.bob')
  if (!existsSync(target) && existsSync(source)) {
    cpSync(source, target, { recursive: true })
  }
}

async function enableBobAsDefault(
  page: Parameters<typeof waitForSessionReady>[0],
  args = ''
): Promise<void> {
  await page.evaluate(
    async ({ agentArgs }) => {
      const store = window.__store
      if (!store) {
        throw new Error('Orca store is unavailable')
      }
      await store.getState().updateSettings({
        disabledTuiAgents: [],
        defaultTuiAgent: 'bob',
        agentDefaultArgs: { bob: agentArgs }
      })
    },
    { agentArgs: args }
  )
}

test('IBM Bob launches from the New tab menu with its own identity', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  const homeDir = await electronApp.evaluate(() => process.env.HOME ?? '')
  expect(homeDir).not.toBe('')
  await seedBobProfile(homeDir)

  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await enableBobAsDefault(orcaPage)

  // Detection: the store must list bob once the preflight probe sees the real binary.
  await expect
    .poll(
      () =>
        orcaPage.evaluate(() => {
          const s = window.__store!.getState() as unknown as { detectedAgentIds?: string[] | null }
          return JSON.stringify(s.detectedAgentIds ?? null)
        }),
      { timeout: 30_000 }
    )
    .toContain('bob')

  await orcaPage.getByRole('button', { name: 'New tab' }).click({ force: true })
  const bobItem = orcaPage.getByRole('menuitem', { name: /IBM Bob/i }).first()
  await expect(bobItem).toBeVisible({ timeout: 15_000 })
  await testInfo.attach('new-tab-menu', {
    body: await orcaPage.screenshot(),
    contentType: 'image/png'
  })
  await bobItem.click({ force: true })

  await focusActiveTerminalInput(orcaPage)
  await waitForTerminalOutput(orcaPage, BOB_COMPOSER_HINT, 40_000)
  const activeTab = orcaPage.locator('[data-testid="sortable-tab"][data-active="true"]')
  await expect(activeTab).toHaveAttribute('data-tab-title', /bob/i)
  // Why: the bundled bob.png is inlined by the bundler, so assert icon presence plus the store's agent identity.
  await expect(activeTab.locator('img')).toHaveCount(1)
  const tabAgent = await orcaPage.evaluate(() => {
    const s = window.__store!.getState() as unknown as {
      activeTabId?: string | null
      tabs?: Record<string, { launchAgent?: string | null; agent?: string | null }>
      tabsByWorktree?: Record<string, { id: string; launchAgent?: string | null }[]>
    }
    const all = Object.values(s.tabsByWorktree ?? {}).flat()
    const active = all.find((t) => t.id === s.activeTabId)
    return active?.launchAgent ?? null
  })
  testInfo.annotations.push({ type: 'active-tab-launchAgent', description: String(tabAgent) })
  await testInfo.attach('bob-launched', {
    body: await orcaPage.screenshot(),
    contentType: 'image/png'
  })

  // Composer accepts typed input without submitting.
  await orcaPage.keyboard.type('e2e typed but not sent')
  await expect
    .poll(() => getTerminalContent(orcaPage), { timeout: 10_000 })
    .toContain('e2e typed but not sent')
  const content = await getTerminalContent(orcaPage)
  expect(content).not.toMatch(/auto-approve/)
  await testInfo.attach('bob-typed', {
    body: await orcaPage.screenshot(),
    contentType: 'image/png'
  })
})

test('IBM Bob honors the yolo (auto-approve) default args', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  const homeDir = await electronApp.evaluate(() => process.env.HOME ?? '')
  await seedBobProfile(homeDir)
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await enableBobAsDefault(orcaPage, '--auto-approve')

  await orcaPage.getByRole('button', { name: 'New tab' }).click({ force: true })
  const bobItem = orcaPage.getByRole('menuitem', { name: /IBM Bob/i }).first()
  await expect(bobItem).toBeVisible({ timeout: 15_000 })
  await bobItem.click({ force: true })
  await focusActiveTerminalInput(orcaPage)
  await waitForTerminalOutput(orcaPage, 'auto-approve', 40_000)
  await testInfo.attach('bob-yolo', { body: await orcaPage.screenshot(), contentType: 'image/png' })
})

test('Create Workspace defaults to IBM Bob and launches it first', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  const homeDir = await electronApp.evaluate(() => process.env.HOME ?? '')
  await seedBobProfile(homeDir)
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await enableBobAsDefault(orcaPage)
  const worktreeIdBefore = await getActiveWorktreeId(orcaPage)

  await orcaPage.getByRole('button', { name: 'New workspace', exact: true }).click()
  const dialog = orcaPage.getByRole('dialog', { name: /Create (Workspace|Worktree)/i })
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('[data-workspace-name-input="true"]')).toBeVisible()
  await orcaPage.waitForTimeout(300)

  const name = `bob-e2e-${Date.now().toString(36)}`
  await dialog.locator('[data-workspace-name-input="true"]').fill(name)

  // Dump every form control so the prompt field can be located precisely.
  const controls = await dialog.locator('textarea, input, [role="combobox"]').evaluateAll((els) =>
    els.map((el) => ({
      tag: el.tagName,
      placeholder: el.getAttribute('placeholder'),
      aria: el.getAttribute('aria-label'),
      testid: el.getAttribute('data-testid'),
      text: (el.textContent ?? '').trim().slice(0, 40)
    }))
  )
  console.log('[bob-e2e] composer controls', JSON.stringify(controls))
  testInfo.annotations.push({ type: 'composer-controls', description: JSON.stringify(controls) })

  // Agent picker should already show Bob as the default.
  const agentTrigger = dialog
    .getByRole('combobox')
    .filter({ hasText: /IBM Bob/i })
    .first()
  const pickerShowsBob = await agentTrigger.isVisible().catch(() => false)
  expect(pickerShowsBob).toBe(true)
  await testInfo.attach('composer', { body: await orcaPage.screenshot(), contentType: 'image/png' })

  // Why: the quick composer has no prompt field (name, project, run-on, agent, branch, note);
  // prompt delivery is covered by the orchestration worker path.
  const promptVisible = false

  const createButton = dialog.getByRole('button', { name: /Create (Workspace|Worktree)/i })
  await expect(createButton).toBeEnabled()
  await createButton.click()
  await expect(dialog).toBeHidden({ timeout: 20_000 })
  await expect.poll(() => worktreeExists(orcaPage, name), { timeout: 15_000 }).toBe(true)
  await expect
    .poll(async () => (await getActiveWorktreeId(orcaPage)) !== worktreeIdBefore, {
      timeout: 15_000
    })
    .toBe(true)

  await focusActiveTerminalInput(orcaPage)
  await waitForTerminalOutput(orcaPage, BOB_COMPOSER_HINT, 60_000)
  if (promptVisible) {
    await expect
      .poll(() => getTerminalContent(orcaPage), { timeout: 20_000 })
      .toContain('E2E PROMPT')
  }
  await testInfo.attach('workspace-bob', {
    body: await orcaPage.screenshot(),
    contentType: 'image/png'
  })
  testInfo.annotations.push({ type: 'picker-shows-bob', description: String(pickerShowsBob) })
  testInfo.annotations.push({ type: 'prompt-field-found', description: String(promptVisible) })
})

async function launchBobFromNewTab(page: Parameters<typeof waitForSessionReady>[0]): Promise<void> {
  await page.getByRole('button', { name: 'New tab' }).click({ force: true })
  const bobItem = page.getByRole('menuitem', { name: /IBM Bob/i }).first()
  await expect(bobItem).toBeVisible({ timeout: 15_000 })
  await bobItem.click({ force: true })
  await focusActiveTerminalInput(page)
  await waitForTerminalOutput(page, BOB_COMPOSER_HINT, 40_000)
}

function countBobChatProcesses(): number {
  try {
    const out = execSync('pgrep -f "bob chat"', { encoding: 'utf8' })
    return out.split('\n').filter((line) => line.trim()).length
  } catch {
    return 0
  }
}

test('Settings › Agents lists IBM Bob as detected and default', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  const homeDir = await electronApp.evaluate(() => process.env.HOME ?? '')
  await seedBobProfile(homeDir)
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await enableBobAsDefault(orcaPage)

  await orcaPage.evaluate(() => {
    const state = window.__store!.getState() as unknown as {
      openSettingsTarget: (target: { pane: string; repoId: string | null }) => void
      openSettingsPage: () => void
    }
    state.openSettingsTarget({ pane: 'agents', repoId: null })
    state.openSettingsPage()
  })

  const bobLabel = orcaPage.getByText('IBM Bob', { exact: true }).first()
  await expect(bobLabel).toBeVisible({ timeout: 30_000 })
  await expect(orcaPage.getByText(/^Default$/).first()).toBeVisible()
  await testInfo.attach('settings-agents', {
    body: await orcaPage.screenshot(),
    contentType: 'image/png'
  })
  const paneText = await orcaPage.locator('main, [role="main"], body').first().innerText()
  const bobIdx = paneText.indexOf('IBM Bob')
  const defaultIdx = paneText.indexOf('Default', bobIdx)
  console.log(
    '[bob-e2e] settings text around Bob:',
    JSON.stringify(paneText.slice(Math.max(0, bobIdx - 80), bobIdx + 160))
  )
  expect(bobIdx).toBeGreaterThanOrEqual(0)
  expect(defaultIdx).toBeGreaterThanOrEqual(0)
})

test('closing the IBM Bob pane stops its process', async ({ electronApp, orcaPage }, testInfo) => {
  const homeDir = await electronApp.evaluate(() => process.env.HOME ?? '')
  await seedBobProfile(homeDir)
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await enableBobAsDefault(orcaPage)

  const baseline = countBobChatProcesses()
  await launchBobFromNewTab(orcaPage)
  await expect.poll(countBobChatProcesses, { timeout: 10_000 }).toBe(baseline + 1)

  // Known gap: sidebar agent rows are seeded from hook/OSC-title status, which Bob never emits.
  const agentRows = orcaPage.locator('[data-testid="agent-row"]')
  await orcaPage.waitForTimeout(5_000)
  const rowCount = await agentRows.count()
  console.log('[bob-e2e] sidebar agent rows for a live Bob pane:', rowCount)
  testInfo.annotations.push({ type: 'sidebar-agent-rows', description: String(rowCount) })
  await testInfo.attach('sidebar-agent-row', {
    body: await orcaPage.screenshot(),
    contentType: 'image/png'
  })

  // Why: closeActiveTerminalPane only closes splits; a single-pane tab is closed via the store.
  await orcaPage.evaluate(() => {
    const state = window.__store!.getState() as unknown as {
      activeTabId?: string | null
      closeTab: (tabId: string) => void
    }
    if (state.activeTabId) {
      state.closeTab(state.activeTabId)
    }
  })
  await expect.poll(countBobChatProcesses, { timeout: 20_000 }).toBe(baseline)
})
