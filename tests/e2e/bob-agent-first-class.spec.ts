/**
 * Exploratory first-class-agent pass for IBM Bob against the REAL `bob` binary.
 *
 * Why: Bob has no stub and needs a logged-in ~/.bob, so this spec is gated on
 * ORCA_E2E_REAL_BOB=1 and copies the developer's Bob profile into the isolated
 * HOME. It is a manual validation aid, not a CI gate.
 */
import { execSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs'
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
// Why: the process-count test uses a system-wide pgrep, so sibling tests must not overlap.
test.describe.configure({ mode: 'serial' })

const BOB_COMPOSER_HINT = 'Build Anything'

// Why: only what a logged-in Bob needs to start (license consent + auth). The task
// DB, logs, MCP and skill configs stay out of the disposable profile, and the copy
// is owner-only so a captured test-results tree never widens the secret's exposure.
const BOB_PROFILE_FILES = ['settings/settings.json', 'settings/auth-secrets.json'] as const

async function seedBobProfile(homeDir: string): Promise<void> {
  const source = process.env.ORCA_E2E_BOB_HOME ?? path.join(os.homedir(), '.bob')
  const target = path.join(homeDir, '.bob')
  if (existsSync(target) || !existsSync(source)) {
    return
  }
  for (const relative of BOB_PROFILE_FILES) {
    const from = path.join(source, relative)
    if (!existsSync(from)) {
      continue
    }
    const to = path.join(target, relative)
    mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 })
    copyFileSync(from, to)
    chmodSync(to, 0o600)
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
  expect(tabAgent).toBe('bob')
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
  const nameInput = dialog.locator('[data-workspace-name-input="true"]')
  await expect(nameInput).toBeEditable()

  const name = `bob-e2e-${Date.now().toString(36)}`
  await nameInput.fill(name)

  // Agent picker should already show Bob as the default.
  const agentTrigger = dialog
    .getByRole('combobox')
    .filter({ hasText: /IBM Bob/i })
    .first()
  const pickerShowsBob = await agentTrigger.isVisible().catch(() => false)
  expect(pickerShowsBob).toBe(true)
  await testInfo.attach('composer', { body: await orcaPage.screenshot(), contentType: 'image/png' })

  // Why no prompt assertion: the quick composer has no prompt field; prompt
  // delivery is covered by the orchestration worker path.
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
  await testInfo.attach('workspace-bob', {
    body: await orcaPage.screenshot(),
    contentType: 'image/png'
  })
  testInfo.annotations.push({ type: 'picker-shows-bob', description: String(pickerShowsBob) })
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
  // Why: prove Bob owns the default — the row button titled "Default agent" must sit in
  // the same agent row as the IBM Bob label, not anywhere on the page.
  const bobRowWithDefault = orcaPage
    .locator('div')
    .filter({ has: orcaPage.getByText('IBM Bob', { exact: true }) })
    .filter({ has: orcaPage.getByTitle('Default agent') })
    .last()
  await expect(bobRowWithDefault).toBeVisible({ timeout: 15_000 })
  await expect(bobRowWithDefault.getByTitle('Default agent')).toHaveText(/Default/)
  await testInfo.attach('settings-agents', {
    body: await orcaPage.screenshot(),
    contentType: 'image/png'
  })
})

test('IBM Bob gets a scraped sidebar status row and closing the pane stops its process', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  // Why: the process count uses pgrep; Windows needs a process-table query before this can run there.
  test.skip(process.platform === 'win32', 'pgrep-based process check has no Windows equivalent yet')
  const homeDir = await electronApp.evaluate(() => process.env.HOME ?? '')
  await seedBobProfile(homeDir)
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await enableBobAsDefault(orcaPage)

  const baseline = countBobChatProcesses()
  await launchBobFromNewTab(orcaPage)
  await expect.poll(countBobChatProcesses, { timeout: 10_000 }).toBe(baseline + 1)

  // Why: Bob emits no hooks or title status; its sidebar row comes from the
  // output-status scrape, which (like Command Code) only has a turn to report
  // once a prompt is submitted.
  await orcaPage.keyboard.type('reply with exactly: PONG')
  await orcaPage.keyboard.press('Enter')
  const readBobRows = () =>
    orcaPage.evaluate(() => {
      const s = window.__store!.getState() as unknown as {
        agentStatusByPaneKey: Record<
          string,
          { agentType?: string; state?: string; prompt?: string }
        >
      }
      return Object.values(s.agentStatusByPaneKey)
        .filter((e) => e.agentType === 'bob')
        .map((e) => `${e.state}:${e.prompt}`)
    })
  await expect
    .poll(readBobRows, { timeout: 30_000 })
    .toContainEqual(expect.stringMatching(/^(working|done):reply with exactly: PONG$/))
  await expect
    .poll(readBobRows, { timeout: 60_000 })
    .toContainEqual('done:reply with exactly: PONG')
  // Why: the worktree card renders the compact agent row as "<title> - IBM Bob".
  await expect(orcaPage.getByText(/bob - IBM Bob/).first()).toBeVisible({ timeout: 15_000 })
  await testInfo.attach('sidebar-bob-row', {
    body: await orcaPage.screenshot(),
    contentType: 'image/png'
  })
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
