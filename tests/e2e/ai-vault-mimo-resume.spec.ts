import { chmodSync, copyFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import Database from '../../src/main/sqlite/sync-database'
import { expect, test } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { execInTerminal, getTerminalContent, waitForActivePanePtyId } from './helpers/terminal'

const SESSION_ID = 'e2e-mimo-vault-resume'
const SESSION_TITLE = 'E2E MiMo Vault Resume'
const OUTPUT_MARKER = 'MIMO_RESUME_STUB_STARTED'
const stubPath = path.join(process.cwd(), 'tests', 'e2e', 'fixtures', 'mimo-resume-stub.mjs')

test.skip(
  process.platform === 'win32',
  'The MiMo Code CLI is currently distributed for POSIX hosts.'
)

test('resumes a MiMo Code AI Vault session in a live terminal @headful', async ({
  electronApp,
  orcaPage,
  testRepoPath
}) => {
  const sessionCwd = await createSessionCwd(electronApp)
  expect(sessionCwd).not.toBe(testRepoPath)
  const mimoStubCommand = await installMimoStub(electronApp)
  await seedMimoSession(electronApp, sessionCwd)
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await configureMimoStub(orcaPage, mimoStubCommand)

  const sessions = await orcaPage.evaluate(async () =>
    window.api.aiVault.listSessions({
      executionHostScope: 'local',
      agents: ['mimo-code'],
      force: true
    })
  )
  expect(sessions.sessions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ agent: 'mimo-code', sessionId: SESSION_ID, title: SESSION_TITLE })
    ])
  )

  await openAiVaultSidebar(orcaPage)
  await orcaPage.getByRole('radio', { name: /^(All|全部)$/ }).click()
  const title = orcaPage.getByText(SESSION_TITLE, { exact: true })
  await expect(title.first()).toBeVisible({ timeout: 30_000 })
  await installResumeProbe(orcaPage)
  const tabCountBeforeResume = await activeWorktreeTerminalTabCount(orcaPage)
  await title.first().click()
  const row = title.first().locator('xpath=ancestor::div[contains(@class,"group/session-row")]')
  await row.hover()
  const resumeButton = row.getByTestId('ai-vault-session-resume')
  await expect(resumeButton).toBeEnabled()
  await resumeButton.click()
  await expect
    .poll(() => activeWorktreeTerminalTabCount(orcaPage), {
      timeout: 10_000,
      message: 'AI Vault resume should create a terminal tab'
    })
    .toBe(tabCountBeforeResume + 1)

  const ptyId = await waitForActivePanePtyId(orcaPage, 20_000)
  // Why poll the marker and not just a prompt: the prompt (with the queued command echoed)
  // renders ~40ms after shell-ready, but the submitted command executes ~90ms after that —
  // capturing between the two made this assertion flake.
  await expect
    .poll(() => getTerminalContent(orcaPage), {
      timeout: 10_000,
      message: 'The queued resume command should run without a manual submit'
    })
    .toContain(OUTPUT_MARKER)

  const automaticContent = await getTerminalContent(orcaPage)
  const probe = await readResumeProbe(orcaPage)
  const queuedCommand = probe
    .filter((event) => event.kind === 'pending-added')
    .map((event) => event.command)
    .find((command): command is string => typeof command === 'string')
  expect(queuedCommand, JSON.stringify(probe, null, 2)).toBeTruthy()

  await execInTerminal(orcaPage, ptyId, queuedCommand as string)
  await expect
    .poll(() => getTerminalContent(orcaPage), {
      timeout: 10_000,
      message: 'The same command should run when submitted manually to the spawned PTY'
    })
    .toContain(OUTPUT_MARKER)
  const manualContent = await getTerminalContent(orcaPage)
  expect(manualContent).toContain(`["--session","${SESSION_ID}"]`)
  expect(automaticContent, JSON.stringify(probe, null, 2)).toContain(OUTPUT_MARKER)
})

async function createSessionCwd(electronApp: ElectronApplication): Promise<string> {
  const homeDir = await electronApp.evaluate(({ app }) => app.getPath('home'))
  const sessionCwd = path.join(homeDir, 'mimo-session-cwd')
  mkdirSync(sessionCwd, { recursive: true })
  return sessionCwd
}

async function seedMimoSession(electronApp: ElectronApplication, cwd: string): Promise<void> {
  const homeDir = await electronApp.evaluate(({ app }) => app.getPath('home'))
  const dataDir = path.join(homeDir, '.local', 'share', 'mimocode')
  mkdirSync(dataDir, { recursive: true })
  const db = new Database(path.join(dataDir, 'mimocode.db'))
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, slug TEXT NOT NULL,
      directory TEXT NOT NULL, title TEXT NOT NULL, version TEXT NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL, data TEXT NOT NULL
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
    );
  `)
  db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    SESSION_ID,
    'e2e-project',
    'e2e-mimo',
    cwd,
    SESSION_TITLE,
    '1.0.0',
    Date.now() - 1_000,
    Date.now()
  )
  db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run(
    'message-1',
    SESSION_ID,
    Date.now(),
    Date.now(),
    JSON.stringify({ role: 'user' })
  )
  db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)').run(
    'part-1',
    'message-1',
    SESSION_ID,
    Date.now(),
    Date.now(),
    JSON.stringify({ type: 'text', text: 'Resume this MiMo session' })
  )
  db.close()
}

async function installMimoStub(electronApp: ElectronApplication): Promise<string> {
  const homeDir = await electronApp.evaluate(({ app }) => app.getPath('home'))
  const binDir = path.join(homeDir, 'bin')
  const commandPath = path.join(binDir, 'mimo')
  mkdirSync(binDir, { recursive: true })
  copyFileSync(stubPath, commandPath)
  chmodSync(commandPath, 0o755)
  return commandPath
}

async function configureMimoStub(page: Page, commandPath: string): Promise<void> {
  await page.evaluate(
    async ({ commandPath }) => {
      const store = window.__store
      if (!store) {
        throw new Error('Orca store unavailable')
      }
      await store.getState().updateSettings({
        agentCmdOverrides: {
          ...store.getState().settings?.agentCmdOverrides,
          'mimo-code': `'${commandPath}'`
        },
        agentDefaultArgs: { ...store.getState().settings?.agentDefaultArgs, 'mimo-code': '' }
      })
    },
    { commandPath }
  )
}

async function openAiVaultSidebar(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = window.__store
    if (!store) {
      throw new Error('Orca store unavailable')
    }
    store.getState().setRightSidebarOpen(true)
    store.getState().setRightSidebarTab('vault')
  })
}

type ResumeProbeEvent = {
  kind: string
  tabId?: string
  command?: string
  activeTabId?: string | null
  pendingTabIds?: string[]
  spawnCommand?: string | null
}

async function installResumeProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = window.__store
    if (!store) {
      throw new Error('Orca store unavailable')
    }
    const holder = window as unknown as { __mimoResumeProbe?: ResumeProbeEvent[] }
    holder.__mimoResumeProbe = []
    const originalCreateTab = store.getState().createTab
    const originalConsumeStartup = store.getState().consumeTabStartupCommand
    store.setState({
      createTab: (...args: Parameters<typeof originalCreateTab>) => {
        const options = args[3]
        holder.__mimoResumeProbe?.push({
          kind: 'create-tab-called',
          command: options?.pendingStartup?.command
        })
        const tab = originalCreateTab(...args)
        const startup = store.getState().pendingStartupByTabId[tab.id]
        holder.__mimoResumeProbe?.push({
          kind: 'create-tab-returned',
          tabId: tab.id,
          command: startup?.command,
          activeTabId: store.getState().activeTabId,
          pendingTabIds: Object.keys(store.getState().pendingStartupByTabId)
        })
        return tab
      },
      consumeTabStartupCommand: (...args: Parameters<typeof originalConsumeStartup>) => {
        holder.__mimoResumeProbe?.push({
          kind: 'consume-startup-called',
          tabId: args[0],
          command: args[1].command
        })
        return originalConsumeStartup(...args)
      }
    })
    store.subscribe((state, previous) => {
      const added = Object.entries(state.pendingStartupByTabId).filter(
        ([tabId]) => previous.pendingStartupByTabId[tabId] === undefined
      )
      for (const [tabId, startup] of added) {
        holder.__mimoResumeProbe?.push({
          kind: 'pending-added',
          tabId,
          command: startup.command,
          activeTabId: state.activeTabId,
          pendingTabIds: Object.keys(state.pendingStartupByTabId)
        })
      }
      const removed = Object.keys(previous.pendingStartupByTabId).filter(
        (tabId) => state.pendingStartupByTabId[tabId] === undefined
      )
      for (const tabId of removed) {
        holder.__mimoResumeProbe?.push({
          kind: 'pending-removed',
          tabId,
          activeTabId: state.activeTabId,
          pendingTabIds: Object.keys(state.pendingStartupByTabId)
        })
      }
    })

    const pty = window.api.pty
    const originalSpawn = pty.spawn.bind(pty)
    try {
      pty.spawn = async (options) => {
        holder.__mimoResumeProbe?.push({ kind: 'pty-spawn', spawnCommand: options.command ?? null })
        return originalSpawn(options)
      }
    } catch {
      holder.__mimoResumeProbe.push({ kind: 'pty-spawn-probe-unavailable' })
    }
  })
}

function readResumeProbe(page: Page): Promise<ResumeProbeEvent[]> {
  return page.evaluate(() => {
    const holder = window as unknown as { __mimoResumeProbe?: ResumeProbeEvent[] }
    return holder.__mimoResumeProbe ?? []
  })
}

function activeWorktreeTerminalTabCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    return worktreeId ? (state.tabsByWorktree[worktreeId]?.length ?? 0) : 0
  })
}
