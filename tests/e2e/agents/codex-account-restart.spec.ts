/**
 * Codex account restart, end to end on the real app: the restart only stops Codex, and Orca's normal
 * pane resume brings the same conversation back on the newly selected account.
 *
 * A stand-in Codex (tests/e2e/fixtures/account-restart-stub-codex) records every launch's CODEX_HOME
 * and argv, keeps its rollout under CODEX_HOME, reports its thread to Orca's hook server, and echoes
 * the pid of the process that received typed input.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { expect, type ElectronApplication, type Page } from '@stablyai/playwright-test'
import { test } from '../desktop/electron-fixtures/orca-app'
import {
  ensureTerminalVisible,
  waitForActiveWorktree,
  waitForSessionReady
} from '../desktop/renderer-probes/store'
import { focusActiveTerminalInput } from '../terminal/input/terminal'
import { waitForTerminalOutput } from '../terminal/layout/terminal-pane-operations'
import { getTerminalContent } from '../terminal/layout/terminal-pane-identity'

const THREAD_ID = '00000000-0000-4000-8000-0000000000e2'
const READY_MARKER = 'ACCOUNT_RESTART_STUB_READY'
const SUBMITTED_MARKER = 'ACCOUNT_RESTART_STUB_SUBMITTED'
const fixtureDir = path.join(
  process.cwd(),
  'tests',
  'e2e',
  'fixtures',
  'account-restart-stub-codex'
)
const RECORD_NAME = 'account-restart-launches.jsonl'

type LaunchRecord = {
  pid: number
  codexHome: string | null
  argv: string[]
  threadId: string
  rolloutPath: string
  rolloutExisted: boolean
}

function readLaunches(recordPath: string): LaunchRecord[] {
  if (!existsSync(recordPath)) {
    return []
  }
  return (
    readFileSync(recordPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stand-in Codex writes exactly this shape.
      .map((line) => JSON.parse(line) as LaunchRecord)
  )
}

const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH'
const stubEnv = {
  [pathKey]: [fixtureDir, process.env[pathKey] ?? ''].filter(Boolean).join(path.delimiter),
  ORCA_E2E_RESTART_RECORD_NAME: RECORD_NAME,
  ORCA_E2E_RESTART_THREAD_ID: THREAD_ID
}

test.skip(process.platform === 'win32', 'the stand-in Codex is a POSIX script')

async function launchCodex(orcaPage: Page): Promise<void> {
  await orcaPage.getByRole('button', { name: 'New tab' }).click({ force: true })
  const codexItem = orcaPage.getByRole('menuitem', { name: /^Codex(?:\s|$)/i }).first()
  await expect(codexItem).toBeVisible({ timeout: 15_000 })
  await codexItem.click({ force: true })
  await waitForTerminalOutput(orcaPage, READY_MARKER, 30_000)
  await expect(orcaPage.getByRole('treeitem', { name: /Codex/ })).toBeVisible()
}

/** Seeds accounts A (selected) and B, launches Codex on A, then switches to B from Settings. */
async function launchOnAThenSelectB(orcaPage: Page, electronApp: ElectronApplication) {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)

  // Two managed accounts with Orca-owned homes; A is selected.
  const userData = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  const launches = () => readLaunches(path.join(userData, RECORD_NAME))
  const now = Date.now()
  const accounts = ['acct-a', 'acct-b'].map((id) => {
    const home = path.join(userData, 'codex-accounts', id, 'home')
    mkdirSync(home, { recursive: true })
    writeFileSync(path.join(home, '.orca-managed-home'), id)
    writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'e2e' }))
    return {
      id,
      email: `${id}@example.com`,
      managedHomePath: home,
      createdAt: now,
      updatedAt: now,
      lastAuthenticatedAt: now
    }
  })
  await orcaPage.evaluate(async (managed) => {
    const store = window.__store
    if (!store) {
      throw new Error('Orca store is unavailable')
    }
    await store.getState().updateSettings({
      codexManagedAccounts: managed,
      activeCodexManagedAccountId: 'acct-a',
      defaultTuiAgent: 'codex',
      agentCmdOverrides: { codex: 'account-restart-codex' }
    })
  }, accounts)

  await launchCodex(orcaPage)
  await expect.poll(() => launches().length, { timeout: 15_000 }).toBe(1)

  // Switch to B the way a user does (Settings > Accounts); the pane is now stale and offers the restart.
  await orcaPage.evaluate(() => {
    const state = window.__store!.getState()
    state.openSettingsTarget({ pane: 'accounts', repoId: null })
    state.openSettingsPage()
  })
  const accountB = orcaPage.getByRole('button', { name: /acct-b@example\.com/ }).first()
  await expect(accountB).toBeVisible({ timeout: 20_000 })
  await accountB.click()
  await expect
    .poll(
      () =>
        orcaPage.evaluate(
          () => window.__store!.getState().settings?.activeCodexManagedAccountId ?? null
        ),
      { timeout: 15_000 }
    )
    .toBe('acct-b')
  await orcaPage.evaluate(() => window.__store!.getState().closeSettingsPage())
  return { accounts, launches, userData }
}

test.describe('on the planned account home', () => {
  test.use({ launchEnv: stubEnv })

  test('restart only stops Codex; the pane resumes the same conversation on the new account', async ({
    orcaPage,
    electronApp
  }) => {
    const { accounts, launches } = await launchOnAThenSelectB(orcaPage, electronApp)
    expect(launches()[0]!.codexHome).toBe(accounts[0]!.managedHomePath)
    const restart = orcaPage.getByRole('button', { name: 'Restart', exact: true })
    await expect(restart).toBeVisible({ timeout: 30_000 })
    await restart.click()

    // Exactly one resume of the same thread, on B's home, with the transcript carried over.
    await expect.poll(() => launches().length, { timeout: 60_000 }).toBe(2)
    const resumed = launches()[1]!
    expect(resumed.argv).toContain('resume')
    expect(resumed.threadId).toBe(THREAD_ID)
    expect(resumed.codexHome).toBe(accounts[1]!.managedHomePath)
    expect(resumed.rolloutExisted).toBe(true)
    await expect(orcaPage.getByText("Can't restart automatically")).toHaveCount(0)

    // Typed input reaches the resumed process, not the stopped one.
    await focusActiveTerminalInput(orcaPage)
    await orcaPage.keyboard.type('after restart')
    await orcaPage.keyboard.press('Enter')
    await expect
      .poll(() => getTerminalContent(orcaPage), { timeout: 15_000 })
      .toContain(`[${SUBMITTED_MARKER}] ${resumed.pid} after restart`)
    // No third launch appeared while the pane settled.
    expect(launches()).toHaveLength(2)
    await expect(orcaPage.getByRole('treeitem', { name: /Codex/ })).toBeVisible()
  })
})

test.describe('on a home Orca did not plan', () => {
  test.use({
    launchEnv: {
      ...stubEnv,
      ORCA_E2E_RESTART_CUSTOM_HOME: '1'
    }
  })

  test('the restart stops nothing and shows the manual line', async ({ orcaPage, electronApp }) => {
    const { accounts, launches, userData } = await launchOnAThenSelectB(orcaPage, electronApp)
    const original = launches()[0]!
    expect(original.codexHome).toBe(path.join(userData, 'custom-codex-home'))
    const restart = orcaPage.getByRole('button', { name: 'Restart', exact: true })
    await expect(restart).toBeVisible({ timeout: 30_000 })
    await restart.click()
    await expect(
      orcaPage.getByText(
        "Can't restart automatically. Close this pane and start Codex in a new one."
      )
    ).toBeVisible({ timeout: 30_000 })
    await orcaPage.getByRole('button', { name: 'Dismiss', exact: true }).click()
    await focusActiveTerminalInput(orcaPage)
    await orcaPage.keyboard.type('still here')
    await orcaPage.keyboard.press('Enter')
    await expect
      .poll(() => getTerminalContent(orcaPage), { timeout: 15_000 })
      .toContain(`[${SUBMITTED_MARKER}] ${original.pid} still here`)
    expect(launches()).toHaveLength(1)

    const close = orcaPage.getByRole('button', { name: /^Close tab Codex/ })
    await close.click()
    await orcaPage.getByRole('button', { name: /^(Stop agent|Stop and close)$/ }).click()
    await expect(close).toHaveCount(0)
    await launchCodex(orcaPage)
    await expect.poll(() => launches().length).toBe(2)
    expect(launches()[1]!.codexHome).toBe(accounts[1]!.managedHomePath)
  })
})
