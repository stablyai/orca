import {
  expect,
  type ElectronApplication,
  type Locator,
  type Page
} from '@stablyai/playwright-test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveCliCommand } from '../../src/shared/shell/command-resolution/node-cli-command-resolution'
import { quoteStartupArg } from '../../src/shared/agent-launch/startup/tui-agent-startup-shell'
import type { JiraIssue } from '../../src/shared/jira/jira-types'
import { test as base } from './desktop/electron-fixtures/orca-app'
import { buildFakeAgentCommandOverride } from './agents/session-fixtures/fake-agent-command-override'
import {
  attachRepoAndOpenTerminal,
  createRestartSession
} from './desktop/electron-fixtures/orca-restart'
import { waitForSessionReady } from './desktop/renderer-probes/store'

const SUPPORTED = process.platform !== 'win32'
const SYSTEM_DIRS = ['/usr/bin', '/bin', '/usr/sbin', '/sbin']
const STUB_SCRIPT = path.join(
  process.cwd(),
  'tests',
  'e2e',
  'fixtures',
  'structured-claude-stub.cjs'
)

function macLoginShellPathDirs(): string[] {
  if (process.platform !== 'darwin') {
    return []
  }
  const files = [
    '/etc/paths',
    ...(existsSync('/etc/paths.d') ? readdirSync('/etc/paths.d') : []).map((name) =>
      path.join('/etc/paths.d', name)
    )
  ]
  return files.flatMap((file) => readFileSync(file, 'utf8').split('\n').filter(Boolean))
}

const test = base.extend<{ claudeStub: { command: string } }>({
  // oxlint-disable-next-line no-empty-pattern -- Playwright requires fixture dependency destructuring.
  claudeStub: async ({}, provideFixture, testInfo) => {
    testInfo.skip(!SUPPORTED, 'the Claude stub wrapper is POSIX-only')
    const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-task-prompt-'))
    try {
      const command = path.join(dir, 'claude')
      const launchLog = path.join(dir, 'launches.jsonl')
      const emptyHome = path.join(dir, 'empty-home')
      mkdirSync(emptyHome)
      // Login shells must not select a real Claude before the fixture's restricted PATH.
      const shadowing = resolveCliCommand('claude', {
        pathEnv: [...SYSTEM_DIRS, ...macLoginShellPathDirs()].join(path.delimiter),
        homePath: emptyHome
      })
      testInfo.skip(path.isAbsolute(shadowing), 'a system-wide claude would shadow the stub')
      const commandLine = [process.execPath, STUB_SCRIPT, launchLog]
        .map((value) => quoteStartupArg(value, 'posix'))
        .join(' ')
      writeFileSync(command, `#!/bin/sh\nexec ${commandLine} "$@"\n`)
      chmodSync(command, 0o755)
      await provideFixture({ command })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
  launchEnv: async ({ claudeStub }, provideFixture) => {
    await provideFixture({
      PATH: [path.dirname(claudeStub.command), ...SYSTEM_DIRS].join(path.delimiter)
    })
  }
})

const GLOBAL_TEMPLATE = '{{url}} /global-ticket'
const PROJECT_TEMPLATE = '{{url}} /jira-engineer'

function syntheticIssue(number: number): JiraIssue {
  return {
    id: `prompt-fixture-${number}`,
    key: `DEMO-${number}`,
    siteId: 'prompt-fixture-site',
    title: `Synthetic task prompt regression ${number}`,
    url: `https://example.atlassian.net/browse/DEMO-${number}`,
    project: { id: 'prompt-fixture-project', key: 'DEMO', name: 'Synthetic demo' },
    issueType: { id: 'task', name: 'Task' },
    status: { id: 'open', name: 'To Do', categoryKey: 'new', categoryName: 'To Do' },
    labels: [],
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z'
  }
}

async function openPromptSetting(page: Page, repoId?: string): Promise<Locator> {
  await page.evaluate((repoId) => {
    const state = window.__store?.getState()
    if (!state) {
      throw new Error('Store unavailable')
    }
    state.setSettingsSearchQuery('')
    state.openSettingsTarget(repoId ? { pane: 'repo', repoId } : { pane: 'tasks', repoId: null })
    state.openSettingsPage()
  }, repoId)
  const input = page.getByRole('textbox', { name: 'Task start prompt', exact: true })
  await expect(input).toBeVisible()
  return input
}

async function savePrompt(page: Page, template: string, repoId?: string): Promise<void> {
  const input = await openPromptSetting(page, repoId)
  await input.fill(template)
  await input.press('Tab')
  await expect(page.getByRole('status').filter({ hasText: /^Saved$/ })).toBeVisible()
  await expect(input).toHaveValue(template)
}

async function createSyntheticJiraWorkspace(
  page: Page,
  issue: JiraIssue,
  expectedDraft: string
): Promise<void> {
  await page.evaluate((issue) => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    const state = store.getState()
    if (!state.settings) {
      throw new Error('Settings unavailable')
    }
    const status = {
      connected: true,
      viewer: null,
      selectedSiteId: 'prompt-fixture-site',
      sites: [
        {
          id: 'prompt-fixture-site',
          siteUrl: 'https://example.atlassian.net',
          email: '',
          displayName: 'Synthetic Jira',
          accountId: 'prompt-fixture-user'
        }
      ]
    }
    // Seed only Jira discovery; settings writes, worktree creation and draft delivery use real IPC.
    store.setState({
      settings: { ...state.settings, defaultTaskSource: 'jira', visibleTaskProviders: ['jira'] },
      jiraStatus: status,
      jiraStatusChecked: true,
      jiraStatusContextKey: 'local#0',
      checkJiraConnection: async () => {},
      readJiraStatus: async () => status,
      listJiraIssues: async () => [issue],
      searchJiraIssues: async () => [issue]
    })
    store.getState().openTaskPage({ taskSource: 'jira' })
  }, issue)

  await expect(page.getByRole('heading', { name: issue.title })).toBeVisible()
  await page.getByRole('button', { name: `Start workspace from ${issue.key}`, exact: true }).click()
  const dialog = page.getByRole('dialog', { name: /Create (workspace|worktree)/i })
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('[data-workspace-source-pill="true"]')).toContainText(issue.key)
  const create = dialog.getByRole('button', { name: /Create (workspace|worktree)/i })
  await expect(create).toBeEnabled({ timeout: 15_000 })
  await create.click()
  await expect(dialog).toBeHidden({ timeout: 30_000 })

  const chat = page.locator('[data-native-chat-root="true"]')
  await expect(chat.getByRole('textbox')).toHaveText(expectedDraft, { timeout: 30_000 })
  await expect(chat.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
  await expect(chat.getByRole('button', { name: 'Stop the agent' })).toHaveCount(0)
  await expect(chat.getByText('Stub reply.', { exact: true })).toHaveCount(0)
}

test('project task prompt overrides global, persists across restart, and resets to inheritance', async ({
  claudeStub,
  launchEnv,
  testRepoPath
}, testInfo) => {
  test.skip(!SUPPORTED, 'the existing Claude stub wrapper is POSIX-only')
  // Three app launches and two real worktree creations share this budget.
  test.setTimeout(240_000)
  const session = createRestartSession(testInfo, {
    ...launchEnv,
    ORCA_BACKGROUND_LAUNCH: '1'
  })
  let currentApp: ElectronApplication | undefined
  try {
    const first = await session.launch()
    currentApp = first.app
    await waitForSessionReady(first.page)
    const worktreeId = await attachRepoAndOpenTerminal(first.page, testRepoPath)
    const repoId = await first.page.evaluate((worktreeId) => {
      const state = window.__store?.getState()
      const worktree = state?.allWorktrees().find((candidate) => candidate.id === worktreeId)
      if (!worktree) {
        throw new Error('Fixture worktree unavailable')
      }
      return worktree.repoId
    }, worktreeId)
    await first.page.evaluate(async (command) => {
      const state = window.__store?.getState()
      if (!state) {
        throw new Error('Store unavailable')
      }
      await state.updateSettingsOrThrow({
        nativeChatProviders: { claude: true },
        defaultTuiAgent: 'claude',
        disabledTuiAgents: [],
        agentCmdOverrides: { claude: command }
      })
    }, buildFakeAgentCommandOverride(claudeStub.command))

    await savePrompt(first.page, GLOBAL_TEMPLATE)
    await savePrompt(first.page, PROJECT_TEMPLATE, repoId)
    const projectIssue = syntheticIssue(701)
    await createSyntheticJiraWorkspace(
      first.page,
      projectIssue,
      `${projectIssue.url} /jira-engineer`
    )
    await first.page.screenshot({ path: testInfo.outputPath('project-jira-draft.png') })

    await session.close(currentApp)
    currentApp = undefined
    const second = await session.launch()
    currentApp = second.app
    await waitForSessionReady(second.page)
    await expect(await openPromptSetting(second.page)).toHaveValue(GLOBAL_TEMPLATE)
    const projectInput = await openPromptSetting(second.page, repoId)
    await expect(projectInput).toHaveValue(PROJECT_TEMPLATE)
    await second.page.getByRole('button', { name: 'Use global prompt', exact: true }).click()
    await expect(second.page.getByRole('status').filter({ hasText: /^Saved$/ })).toBeVisible()
    await expect(projectInput).toHaveValue('')
    await expect(projectInput).toHaveAttribute('placeholder', GLOBAL_TEMPLATE)

    const inheritedIssue = syntheticIssue(702)
    await createSyntheticJiraWorkspace(
      second.page,
      inheritedIssue,
      `${inheritedIssue.url} /global-ticket`
    )
    await second.page.screenshot({ path: testInfo.outputPath('inherited-jira-draft.png') })

    await session.close(currentApp)
    currentApp = undefined
    const third = await session.launch()
    currentApp = third.app
    await waitForSessionReady(third.page)
    const inheritedInput = await openPromptSetting(third.page, repoId)
    await expect(inheritedInput).toHaveValue('')
    await expect(inheritedInput).toHaveAttribute('placeholder', GLOBAL_TEMPLATE)
  } finally {
    await session.dispose(currentApp)
  }
})
