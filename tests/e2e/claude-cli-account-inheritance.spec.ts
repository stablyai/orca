import { retentionFixtureCommand } from './helpers/host-created-terminal-retention-oracle'
import { waitForPtyShellEcho } from './terminal-pty-readiness'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady, waitForActiveWorktree } from './helpers/store'
import { readHookEndpoint } from './helpers/agent-hook-endpoint'
import { execInTerminal, sendToTerminal, waitForActivePanePtyId } from './helpers/terminal'
import { buildFakeAgentCommandOverride } from './helpers/fake-agent-command-override'

type Launch = {
  account: string | null
  configDir: string | null
  terminalHandle: string
  paneKey: string
}

async function prepareAccounts(
  page: Parameters<typeof waitForSessionReady>[0],
  app: Parameters<typeof readHookEndpoint>[0],
  output: string
) {
  await page.setViewportSize({ width: 1440, height: 900 })
  await waitForSessionReady(page)
  const worktreeId = await waitForActiveWorktree(page)
  const userData = await app.evaluate(({ app }) => app.getPath('userData'))
  mkdirSync(output, { recursive: true })
  for (const id of ['account-a', 'account-b']) {
    const home = path.join(userData, 'claude-profiles', id, 'home')
    mkdirSync(home, { recursive: true })
    writeFileSync(
      path.join(home, '.claude.json'),
      JSON.stringify({
        hasCompletedOnboarding: true,
        oauthAccount: {
          emailAddress: `${id}@example.test`,
          accountUuid: id,
          organizationUuid: 'test-org'
        }
      })
    )
  }
  const script = path.join(process.cwd(), 'tests/e2e/fixtures/claude-account-inheritance.cjs')
  const command = path.join(output, process.platform === 'win32' ? 'claude.cmd' : 'claude')
  writeFileSync(
    command,
    process.platform === 'win32'
      ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
      : `#!${process.execPath}\nrequire(${JSON.stringify(script)})\n`
  )
  chmodSync(command, 0o755)
  const ledger = path.join(output, 'launches.jsonl')
  const endpoint = await readHookEndpoint(app)
  await page.evaluate(
    async ({ command, userData, ledger, endpoint, streamLog, cli }) => {
      const account = (id: string) => ({
        id,
        email: `${id}@example.test`,
        authMethod: 'subscription-oauth' as const,
        managedAuthPath: '/unused',
        createdAt: 0,
        updatedAt: 0,
        lastAuthenticatedAt: 0
      })
      await window.__store!.getState().updateSettings({
        claudeManagedAccounts: [account('account-a'), account('account-b')],
        activeClaudeManagedAccountId: 'account-a',
        nativeChatProviders: { claude: false, codex: false },
        defaultTuiAgent: 'claude',
        agentCmdOverrides: { claude: command },
        agentDefaultEnv: {
          claude: {
            ORCA_E2E_ACCOUNT_DATA: userData,
            ORCA_E2E_ACCOUNT_LEDGER: ledger,
            ORCA_E2E_ACCOUNT_HOOK: JSON.stringify(endpoint),
            ORCA_E2E_ACCOUNT_STREAM_LOG: streamLog,
            ORCA_E2E_ACCOUNT_CLI: cli
          }
        }
      })
    },
    {
      command: buildFakeAgentCommandOverride(command),
      userData,
      ledger,
      endpoint,
      streamLog: path.join(output, 'stream.jsonl'),
      cli: path.join(process.cwd(), 'out/cli/index.js')
    }
  )
  const launches = (): Launch[] =>
    existsSync(ledger)
      ? readFileSync(ledger, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : []
  const select = async (id: string | null) =>
    page.evaluate(async (id) => {
      await window.__store!.getState().updateSettings({ activeClaudeManagedAccountId: id })
    }, id)
  const openParent = async () => {
    const previous = new Set(launches().map((launch) => launch.terminalHandle))
    await page.getByRole('button', { name: 'New tab', exact: true }).first().click()
    await page
      .getByRole('menuitem', { name: /^Claude(?:\s|$)/ })
      .first()
      .click()
    await expect
      .poll(() => launches().some((launch) => !previous.has(launch.terminalHandle)))
      .toBe(true)
    const launch = launches().find((launch) => !previous.has(launch.terminalHandle))
    if (!launch) {
      throw new Error('The UI did not start a terminal agent')
    }
    const ptyId = await waitForActivePanePtyId(page)
    await expect
      .poll(async () => {
        const result = await page.evaluate(
          (terminal) => window.api.runtime.call({ method: 'terminal.show', params: { terminal } }),
          launch.terminalHandle
        )
        if (
          !result.ok ||
          typeof result.result !== 'object' ||
          result.result === null ||
          !('terminal' in result.result)
        ) {
          return null
        }
        const terminal = result.result.terminal
        return typeof terminal === 'object' && terminal !== null && 'agentIdentity' in terminal
          ? terminal.agentIdentity
          : null
      })
      .toBe('claude')
    return { ...launch, ptyId }
  }
  let next = 0
  const invoke = async (
    parent: Awaited<ReturnType<typeof openParent>>,
    args: string[],
    env: Record<string, string> = {}
  ) => {
    const file = path.join(output, `cli-${next++}.json`)
    const request = Buffer.from(JSON.stringify({ args, env, output: file })).toString('base64')
    await sendToTerminal(page, parent.ptyId, `ORCA_ACCOUNT_CLI:${request}\r`)
    await expect.poll(() => existsSync(file), { timeout: 95_000 }).toBe(true)
    const run = JSON.parse(readFileSync(file, 'utf8'))
    expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0)
    const response = JSON.parse(run.stdout)
    expect(response.ok).toBe(true)
    return response.result
  }
  const launchArgs = [
    'agent',
    'launch',
    '--agent',
    'claude',
    '--worktree',
    `id:${worktreeId}`,
    '--surface',
    'terminal'
  ]
  return { select, openParent, invoke, launches, launchArgs, worktreeId }
}

test('CLI launches keep the parent account while UI launches follow selection', async ({
  orcaPage: page,
  electronApp
}, info) => {
  const rig = await prepareAccounts(page, electronApp, info.outputDir)
  const parent = await rig.openParent()
  expect(parent.account).toBe('account-a')
  await rig.select('account-b')
  const child = await rig.invoke(parent, rig.launchArgs)
  expect(child.account).toEqual({
    id: 'account-a',
    email: 'account-a@example.test',
    source: 'caller'
  })
  await expect.poll(() => rig.launches().at(-1)?.account).toBe('account-a')
  const replay = await rig.invoke(parent, [...rig.launchArgs, '--retry-launch', child.operationId])
  expect(replay.account.id).toBe('account-a')
  const ui = await rig.openParent()
  expect(ui.account).toBe('account-b')
  await page.screenshot({ path: info.outputPath('inherited-a-ui-b.png') })
})

test('a system-default parent keeps the system-default account', async ({
  orcaPage: page,
  electronApp
}, info) => {
  const rig = await prepareAccounts(page, electronApp, info.outputDir)
  await rig.select(null)
  const parent = await rig.openParent()
  expect(parent.account).toBeNull()
  await rig.select('account-b')
  const child = await rig.invoke(parent, rig.launchArgs, { ORCA_CLAUDE_PROFILE_POINTER: '' })
  expect(child.account).toEqual({ id: null, email: null, source: 'caller' })
  await expect.poll(() => rig.launches().at(-1)?.account).toBeNull()
})

test('a removed caller account falls back to the selected account', async ({
  orcaPage: page,
  electronApp
}, info) => {
  const rig = await prepareAccounts(page, electronApp, info.outputDir)
  const parent = await rig.openParent()
  await rig.select('account-b')
  await page.evaluate(async () => {
    const state = window.__store!.getState()
    await state.updateSettings({
      claudeManagedAccounts: (state.settings?.claudeManagedAccounts ?? []).filter(
        (account) => account.id !== 'account-a'
      )
    })
  })
  const child = await rig.invoke(parent, rig.launchArgs)
  expect(child.account).toEqual({
    id: 'account-b',
    email: 'account-b@example.test',
    source: 'selected'
  })
  await expect.poll(() => rig.launches().at(-1)?.account).toBe('account-b')
})

test('worktree-create launches inherit the calling account', async ({
  orcaPage: page,
  electronApp
}, info) => {
  const rig = await prepareAccounts(page, electronApp, info.outputDir)
  const parent = await rig.openParent()
  await rig.select('account-b')
  const child = await rig.invoke(parent, [
    'worktree',
    'create',
    '--name',
    'account-review',
    '--agent',
    'claude'
  ])
  expect(child.launch.account.id).toBe('account-a')
  await expect.poll(() => rig.launches().at(-1)?.account).toBe('account-a')
})

test('worker-start launches inherit the calling account', async ({
  orcaPage: page,
  electronApp
}, info) => {
  const rig = await prepareAccounts(page, electronApp, info.outputDir)
  const parent = await rig.openParent()
  await rig.select('account-b')
  const child = await rig.invoke(parent, [
    'orchestration',
    'worker-start',
    '--agent',
    'claude',
    '--spec',
    'Review the diff',
    '--worktree',
    'current',
    '--keep-open',
    '--timeout-ms',
    '15000'
  ])
  expect(child.account.id).toBe('account-a')
  await expect.poll(() => rig.launches().at(-1)?.account).toBe('account-a')
})

test('a CLI chat keeps the inherited account until its first message', async ({
  orcaPage: page,
  electronApp
}, info) => {
  const rig = await prepareAccounts(page, electronApp, info.outputDir)
  const parent = await rig.openParent()
  await rig.select('account-b')
  const child = await rig.invoke(parent, [
    'agent',
    'launch',
    '--agent',
    'claude',
    '--worktree',
    `id:${rig.worktreeId}`,
    '--surface',
    'chat'
  ])
  expect(child.account.id).toBe('account-a')
  await page.locator('[data-testid="sortable-tab"]').last().click()
  const chat = page.locator('[data-native-chat-root="true"]')
  await expect(chat).toBeVisible()
  await chat.getByRole('textbox').fill('Hi')
  await chat.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(chat.getByText('Stub reply.', { exact: true })).toBeVisible({ timeout: 30_000 })
  await expect.poll(() => rig.launches().at(-1)?.account).toBe('account-a')
})

test('concurrent callers keep separate inherited accounts', async ({
  orcaPage: page,
  electronApp
}, info) => {
  const rig = await prepareAccounts(page, electronApp, info.outputDir)
  const parentA = await rig.openParent()
  await rig.select('account-b')
  const parentB = await rig.openParent()
  const [a, b] = await Promise.all([
    rig.invoke(parentA, rig.launchArgs),
    rig.invoke(parentB, rig.launchArgs)
  ])
  expect(a.account.id).toBe('account-a')
  expect(b.account.id).toBe('account-b')
  await expect
    .poll(() => rig.launches().find((entry) => entry.terminalHandle === a.outcome.handle)?.account)
    .toBe('account-a')
  await expect
    .poll(() => rig.launches().find((entry) => entry.terminalHandle === b.outcome.handle)?.account)
    .toBe('account-b')
})

test('unrecognized account homes and mismatched panes fall back to selection', async ({
  orcaPage: page,
  electronApp
}, info) => {
  const rig = await prepareAccounts(page, electronApp, info.outputDir)
  const parent = await rig.openParent()
  await rig.select('account-b')
  const unknown = await rig.invoke(parent, rig.launchArgs, {
    CLAUDE_CONFIG_DIR: info.outputPath('unmanaged')
  })
  expect(unknown.account).toEqual({
    id: 'account-b',
    email: 'account-b@example.test',
    source: 'selected'
  })
  await expect
    .poll(
      () => rig.launches().find((entry) => entry.terminalHandle === unknown.outcome.handle)?.account
    )
    .toBe('account-b')
  const mismatched = await rig.invoke(parent, rig.launchArgs, { ORCA_PANE_KEY: 'different:pane' })
  expect(mismatched.account.source).toBe('selected')
  await expect
    .poll(
      () =>
        rig.launches().find((entry) => entry.terminalHandle === mismatched.outcome.handle)?.account
    )
    .toBe('account-b')
})

test('a shell left after Claude exits uses the selected account', async ({
  orcaPage: page,
  electronApp
}, info) => {
  const rig = await prepareAccounts(page, electronApp, info.outputDir)
  const parent = await rig.openParent()
  await rig.select('account-b')
  await sendToTerminal(page, parent.ptyId, 'ORCA_ACCOUNT_EXIT\r')
  await waitForPtyShellEcho(page, parent.ptyId, 15_000)
  const driver = info.outputPath('shell-cli.cjs')
  const sink = info.outputPath('shell-result.json')
  writeFileSync(
    driver,
    `const {spawnSync}=require('node:child_process');const fs=require('node:fs');const result=spawnSync(process.execPath,${JSON.stringify([path.join(process.cwd(), 'out/cli/index.js'), ...rig.launchArgs, '--json'])},{env:{...process.env,ORCA_DEV_CLI_INVOCATION:'1'},encoding:'utf8',windowsHide:true});fs.writeFileSync(process.argv[2],JSON.stringify({code:result.status,stdout:result.stdout,stderr:result.stderr}));`
  )
  await execInTerminal(page, parent.ptyId, retentionFixtureCommand(driver, sink))
  await expect.poll(() => existsSync(sink)).toBe(true)
  const run = JSON.parse(readFileSync(sink, 'utf8'))
  expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0)
  const child = JSON.parse(run.stdout).result
  expect(child.account.source).toBe('selected')
  await expect
    .poll(
      () => rig.launches().find((entry) => entry.terminalHandle === child.outcome.handle)?.account
    )
    .toBe('account-b')
})

test('folder workspace children inherit the calling account', async ({
  orcaPage: page,
  electronApp
}, info) => {
  const rig = await prepareAccounts(page, electronApp, info.outputDir)
  const folderPath = info.outputPath('plain-folder')
  mkdirSync(folderPath)
  const worktree = await page.evaluate(async (folderPath) => {
    const state = window.__store!.getState()
    const group = await window.api.projectGroups.create({
      name: 'Account test',
      parentPath: folderPath,
      createdFrom: 'folder-scan'
    })
    await state.fetchProjectGroups({ runtimeEnvironmentId: null, throwOnError: true })
    const folder = await state.createFolderWorkspace(
      { projectGroupId: group.id, name: 'Plain folder', folderPath },
      { runtimeEnvironmentId: null }
    )
    if (!folder) {
      throw new Error('Folder creation failed')
    }
    return `folder:${folder.id}`
  }, folderPath)
  await page.locator(`[data-worktree-id="${worktree}"]`).first().click()
  const parent = await rig.openParent()
  await rig.select('account-b')
  const child = await rig.invoke(parent, [
    'agent',
    'launch',
    '--agent',
    'claude',
    '--worktree',
    worktree
  ])
  expect(child.account.id).toBe('account-a')
  await expect
    .poll(
      () => rig.launches().find((entry) => entry.terminalHandle === child.outcome.handle)?.account
    )
    .toBe('account-a')
})
