/**
 * A relay-era SSH host converts to managed orcad on connect (#24979), on a real host:
 *
 * 1. Without an orcad template the connect keeps the relay, so the host gains relay-era state: a
 *    repository, a folder workspace, an editor tab, and a relay terminal that has exited.
 * 2. With the template in place and no relay terminal running, the next connect converts it, and
 *    the new server lists that repository and folder and the editor tab.
 * 3. The source rows stay retained and hidden (downgrade safety), across a later connect too:
 *    nothing deletes them automatically.
 *
 * A managed host also updates to a relaunched app's bundled orcad on its next idle connect, and
 * reaches its server when another runtime already holds orcad's preferred port.
 *
 * Host: `ORCA_E2E_ORCAD_CONVERT_HOST=docker` (Linux fixture) or a Windows host-cell descriptor.
 * Template: `ORCA_E2E_ORCAD_CONVERT_TEMPLATE`, built for that host's target.
 */
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ElectronApplication, Page, TestInfo } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import {
  ensureTerminalVisible,
  switchToWorktree,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import { execInTerminal, waitForActivePanePtyId, waitForTerminalOutput } from './helpers/terminal'
import { connectSshTestTarget } from './helpers/ssh-test-target-connection'
import { createRestartSession } from './helpers/orca-restart'
import {
  convertAndRetain,
  managedServer,
  reconnect,
  serverCall,
  targetLeases
} from './helpers/orcad-convert-flow'
import {
  isOrcadFullVersion,
  makeOrcadTemplateVariant,
  readHostOrcadActivation
} from './helpers/orcad-template-variant'
import { seedRelayEraProfile } from './helpers/orcad-upgrade-profile'
import {
  ORCAD_CONVERT_HOST_ENV,
  startOrcadConvertHost,
  type OrcadConvertHost
} from './helpers/orcad-convert-host'
import {
  callEnvironment,
  createPairedHostTerminal,
  openPairedClientTab
} from './helpers/paired-host-terminal'
import { expectTerminalAccessibilityText } from './helpers/terminal-accessibility-tree'
import { toSshExecutionHostId } from '../../src/shared/execution-host'

const HOST = process.env[ORCAD_CONVERT_HOST_ENV]
const TEMPLATE_SOURCE = process.env.ORCA_E2E_ORCAD_CONVERT_TEMPLATE
// Fixed per worker so the app's launch env can name them before the test runs.
const SCRATCH = path.join(os.tmpdir(), `orca-orcad-convert-${process.pid}`)
const TEMPLATE_DIR = path.join(SCRATCH, 'orcad-template')

// Whole file: every test needs a real host and a template built for it.
test.skip(
  !HOST || !TEMPLATE_SOURCE,
  `Set ${ORCAD_CONVERT_HOST_ENV} and ORCA_E2E_ORCAD_CONVERT_TEMPLATE`
)

let host: OrcadConvertHost | null = null
function startHost(testInfo: TestInfo): OrcadConvertHost {
  host = startOrcadConvertHost(HOST!, testInfo)
  return host
}

test.beforeEach(() => {
  rmSync(SCRATCH, { recursive: true, force: true })
  mkdirSync(SCRATCH, { recursive: true })
})

test.afterEach(() => {
  host?.cleanup()
  host = null
  rmSync(SCRATCH, { recursive: true, force: true })
})

test.use({
  orcaAppExtraEnv: {
    ORCA_ORCAD_TEMPLATE_PATH: TEMPLATE_DIR
  }
})

test('a relay host converts to managed orcad on connect and keeps its source', async ({
  orcaPage: page,
  electronApp
}, testInfo) => {
  // Why Docker only: a relay era without the template needs host Node, which the Windows lane hides.
  test.skip(HOST !== 'docker', 'The runtime relay era runs on the Docker host only')
  test.setTimeout(20 * 60_000)
  const host = startHost(testInfo)
  const userData = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  await waitForSessionReady(page)
  const localWorktreeId = await waitForActiveWorktree(page)

  // 1. Relay era: no template, so the connect keeps the relay.
  const remote = await connectSshTestTarget(page, host.input, {
    remotePath: host.remoteRepoPath,
    displayName: 'orcad convert E2E',
    seedInitialTab: true
  })
  expect(await managedServer(page, remote.targetId)).toMatchObject({
    kind: 'relay',
    reason: 'orcad_unavailable'
  })
  const folderPath = await page.evaluate(
    async ({ targetId, folder }) => {
      const group = await window.api.projectGroups.create({
        name: 'orcad convert folders',
        parentPath: folder,
        connectionId: targetId
      })
      const workspace = await window.api.folderWorkspaces.create({
        projectGroupId: group.id,
        folderPath: folder,
        connectionId: targetId
      })
      return workspace.folderPath
    },
    { targetId: remote.targetId, folder: host.remoteFolderPath }
  )
  await ensureTerminalVisible(page, 45_000)
  const ptyId = await waitForActivePanePtyId(page, 60_000)
  const marker = `ORCAD-CONVERT-${Date.now()}`
  await execInTerminal(page, ptyId, `echo ${marker}`)
  await waitForTerminalOutput(page, marker, 30_000)
  // The session tab is an editor: every mounted terminal tab runs a shell, and an exited one closes.
  const sessionFilePath = `${host.remoteRepoPath}/README.md`
  await page.evaluate(
    ({ filePath, worktreeId, hostId }) => {
      // As a sidebar click does: with its host, so the new tab is stamped as that host's.
      window.__store!.getState().setActiveWorktree(worktreeId, hostId)
      window.__store!.getState().openFile({
        filePath,
        relativePath: 'README.md',
        worktreeId,
        language: 'markdown',
        mode: 'edit'
      })
    },
    {
      filePath: sessionFilePath,
      worktreeId: remote.worktreeId,
      hostId: toSshExecutionHostId(remote.targetId)
    }
  )
  // Off the remote worktree first, so nothing there restarts a shell once this one exits.
  await switchToWorktree(page, localWorktreeId)
  // An exited shell leaves an exit record, which is what lets the gate prove no terminal runs.
  await execInTerminal(page, ptyId, 'exit')
  // The connect's terminal gate asks the relay the same question, so a timeout names the blocker.
  await expect
    .poll(
      () =>
        page.evaluate(
          async (connectionId) =>
            JSON.stringify(await window.api.pty.listSessions({ connectionId })),
          remote.targetId
        ),
      { timeout: 30_000 }
    )
    .toBe('[]')
  // The gate's other input: no lease may still read as a running terminal.
  await expect
    .poll(
      () => {
        const live = targetLeases(userData, remote.targetId).filter(
          (lease) => lease.state === 'attached' || lease.state === 'detached'
        )
        return JSON.stringify(live)
      },
      { timeout: 30_000 }
    )
    .toBe('[]')
  // An SSH worktree's session lives in its host's partition, not the local one.
  await expect
    .poll(
      () =>
        page.evaluate(
          async ({ hostId, filePath }) =>
            JSON.stringify(await window.api.session.get(hostId)).includes(filePath),
          { hostId: toSshExecutionHostId(remote.targetId), filePath: sessionFilePath }
        ),
      { timeout: 30_000 }
    )
    .toBe(true)

  // 2. Template in place: the next connect converts the host.
  cpSync(TEMPLATE_SOURCE!, TEMPLATE_DIR, { recursive: true })
  // A shell that starts after the checks above still blocks the gate: it must stay empty a while.
  for (const deadline = Date.now() + 5_000; Date.now() < deadline;) {
    expect(
      JSON.stringify({
        sessions: await page.evaluate(
          (connectionId) => window.api.pty.listSessions({ connectionId }),
          remote.targetId
        ),
        leases: targetLeases(userData, remote.targetId).filter(
          (lease) => lease.state === 'attached' || lease.state === 'detached'
        )
      })
    ).toBe(JSON.stringify({ sessions: [], leases: [] }))
    await new Promise((settle) => setTimeout(settle, 500))
  }
  await convertAndRetain(page, userData, {
    targetId: remote.targetId,
    worktreeId: remote.worktreeId,
    repoPath: host.remoteRepoPath,
    folderPath,
    sessionFilePath
  })
})

test('a relay-era profile converts its SSH host on the first connect after upgrading', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(20 * 60_000)
  const host = startHost(testInfo)
  const session = createRestartSession(testInfo, {
    ORCA_ORCAD_TEMPLATE_PATH: TEMPLATE_SOURCE!
  })
  let app: ElectronApplication | null = null
  try {
    // The first launch only establishes the profile the relay-era rows are written into.
    const first = await session.launch()
    app = first.app
    await waitForSessionReady(first.page)
    await first.page.evaluate((repoPath) => window.api.repos.add({ path: repoPath }), testRepoPath)
    await session.close(app)
    app = null
    const seeded = seedRelayEraProfile(session.userDataDir, host.input, {
      repoPath: host.remoteRepoPath,
      folderPath: host.remoteFolderPath
    })
    // No relay ever ran here, so the terminal gate must prove `exited` from an empty lease set.
    // This launch bypasses the fixture's log relay; keep the SSH lines a failed move explains itself by.
    const upgraded = await session.launch({
      onStderr: (chunk) => {
        if (chunk.includes('[ssh]')) {
          process.stderr.write(chunk)
        }
      }
    })
    app = upgraded.app
    await waitForSessionReady(upgraded.page)
    await convertAndRetain(upgraded.page, session.userDataDir, seeded)
    const environment = (
      await upgraded.page.evaluate(() => window.api.runtimeEnvironments.list())
    ).find((entry) => entry.orcadDeployment?.sshTargetId === seeded.targetId)
    if (!environment) {
      throw new Error('Converted host is missing from the environment catalog')
    }
    const hostId = `runtime:${environment.id}` as const
    await upgraded.page.evaluate((hostId) => {
      const state = window.__store!.getState()
      state.setGroupBy('none')
      window.__store!.setState({ visibleWorkspaceHostIds: ['local', hostId] })
    }, hostId)
    const folder = upgraded.page.getByText('orcad upgrade folder', { exact: true })
    await expect(folder).toBeVisible()
    await upgraded.page.screenshot({ path: testInfo.outputPath('managed-folder-host-section.png') })
    const sectionHeader = folder.locator('xpath=preceding::*[@data-host-header-drag-id][1]')
    await expect(sectionHeader).toHaveAttribute('data-host-header-drag-id', hostId)
    const managedHeader = upgraded.page.locator(`[data-host-header-drag-id="${hostId}"]`)
    await managedHeader.click()
    await expect(folder).toBeHidden()
    await managedHeader.click()
    await expect(folder).toBeVisible()
    if (!host.exec) {
      return
    }
    await upgraded.page.evaluate(
      ({ worktreeId, environmentId }) => {
        window.__store!.getState().setActiveWorktree(worktreeId, `runtime:${environmentId}`)
      },
      { worktreeId: seeded.worktreeId, environmentId: environment.id }
    )
    const terminal = await createPairedHostTerminal(
      upgraded.page,
      environment.id,
      seeded.worktreeId,
      'bash'
    )
    await openPairedClientTab(upgraded.page, seeded.worktreeId, terminal.webTabId)
    await callEnvironment(upgraded.page, environment.id, 'terminal.send', {
      terminal: terminal.terminal,
      text: "orca status --json > /tmp/orca-cli-status.json && orca worktree ps --json > /tmp/orca-cli-workers.json && printf 'QA_%s\\n' 'CLI_READY'",
      enter: true
    })
    await expectTerminalAccessibilityText(upgraded.page, terminal.webTabId, 'QA_CLI_READY')
    const status = JSON.parse(host.exec('cat /tmp/orca-cli-status.json'))
    expect(status.result.runtime).toMatchObject({
      reachable: true,
      runtimeId: environment.runtimeId
    })
    expect(status.result.app.desktopWindowStatus).toBe('blocked')
    await upgraded.page.screenshot({ path: testInfo.outputPath('managed-cli-ready.png') })
  } finally {
    if (app) {
      await session.close(app)
    }
    await session.dispose()
  }
})

test('a host whose sshd refuses TCP forwarding runs a managed server over the stdio bridge', async ({
  orcaPage: page
}, testInfo) => {
  test.skip(HOST !== 'docker', 'Only the Docker host can change its sshd policy mid-test')
  test.setTimeout(15 * 60_000)
  cpSync(TEMPLATE_SOURCE!, TEMPLATE_DIR, { recursive: true })
  const host = startHost(testInfo)
  host.blockTcpForwarding!()
  await waitForSessionReady(page)
  // Just the connect: a managed host serves repositories through its server, not the relay.
  const targetId = await page.evaluate(async (input) => {
    const { target } = await window.api.ssh.addTarget({ target: input })
    await window.api.ssh.connect({ targetId: target.id })
    return target.id
  }, host.input)
  const mainServer = (): Promise<string> =>
    page.evaluate(
      async (id) =>
        JSON.stringify((await window.api.ssh.getState({ targetId: id }))?.managedServer ?? null),
      targetId
    )

  await expect.poll(mainServer, { timeout: 8 * 60_000 }).toContain('"kind":"managed"')
  const target = await page.evaluate(
    async (id) => (await window.api.ssh.listTargets()).find((entry) => entry.id === id),
    targetId
  )
  expect(target?.orcadFence).toBeTruthy()
  expect(target).not.toHaveProperty('managedServerUnavailable')
  const environment = (await page.evaluate(() => window.api.runtimeEnvironments.list())).find(
    (entry) => entry.orcadDeployment?.sshTargetId === targetId
  )
  expect(environment, 'a managed server registered for the host').toBeTruthy()
  // sshd refuses every forward, so this call can only have ridden a stdio bridge.
  await serverCall(page, environment!.id, 'repo.list')

  // A reconnect rebuilds the tunnel the same way.
  await reconnect(page, targetId)
  await expect.poll(mainServer, { timeout: 2 * 60_000 }).toContain('"kind":"managed"')
  await serverCall(page, environment!.id, 'repo.list')
})

test('a host whose port 6768 another runtime holds still runs a managed server', async ({
  orcaPage: page
}, testInfo) => {
  test.skip(HOST !== 'docker', 'Only the Docker host can start a listener mid-test')
  test.setTimeout(15 * 60_000)
  cpSync(TEMPLATE_SOURCE!, TEMPLATE_DIR, { recursive: true })
  const host = startHost(testInfo)
  // Stands in for a desktop Orca on the host: it holds 6768 and turns every client away.
  host.exec!(
    `setsid nohup node -e "require('net').createServer((s) => s.destroy()).listen(6768, '127.0.0.1')" >/dev/null 2>&1 &`
  )
  await expect
    .poll(() => host.exec!(`(echo > /dev/tcp/127.0.0.1/6768) 2>/dev/null && echo held || true`))
    .toContain('held')
  await waitForSessionReady(page)
  const targetId = await page.evaluate(async (input) => {
    const { target } = await window.api.ssh.addTarget({ target: input })
    await window.api.ssh.connect({ targetId: target.id })
    return target.id
  }, host.input)

  await expect
    .poll(() => managedServer(page, targetId), { timeout: 8 * 60_000 })
    .toMatchObject({ kind: 'managed' })
  const environment = (await page.evaluate(() => window.api.runtimeEnvironments.list())).find(
    (entry) => entry.orcadDeployment?.sshTargetId === targetId
  )
  expect(environment, 'a managed server registered for the host').toBeTruthy()
  // The other listener drops every connection, so this call can only have reached orcad.
  await serverCall(page, environment!.id, 'repo.list')

  // A reconnect reads the bound port again rather than assuming 6768.
  await reconnect(page, targetId)
  await expect
    .poll(() => managedServer(page, targetId), { timeout: 2 * 60_000 })
    .toMatchObject({ kind: 'managed' })
  await serverCall(page, environment!.id, 'repo.list')
})

test('a managed host updates to the bundled orcad on the first connect after an app update', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
{}, testInfo) => {
  test.skip(HOST !== 'docker', 'Reads the activation record through the Docker host')
  test.setTimeout(20 * 60_000)
  cpSync(TEMPLATE_SOURCE!, TEMPLATE_DIR, { recursive: true })
  const host = startHost(testInfo)
  const session = createRestartSession(testInfo, {
    ORCA_ORCAD_TEMPLATE_PATH: TEMPLATE_DIR
  })
  let app: ElectronApplication | null = null
  try {
    // Template A: the empty host deploys managed orcad on its first connect.
    const first = await session.launch()
    app = first.app
    await waitForSessionReady(first.page)
    const targetId = await first.page.evaluate(async (input) => {
      const { target } = await window.api.ssh.addTarget({ target: input })
      return target.id
    }, host.input)
    await connectOnce(first.page, targetId)
    await expect
      .poll(() => managedServer(first.page, targetId), { timeout: 8 * 60_000 })
      .toMatchObject({ kind: 'managed' })
    const deployed = readHostOrcadActivation(host.exec!)
    expect(isOrcadFullVersion(deployed.active)).toBe(true)
    await session.close(app)
    app = null

    // Template B, as an app update would bundle: the tunnel restore or the next connect updates it.
    makeOrcadTemplateVariant(TEMPLATE_DIR, 'B')
    const updated = await session.launch({
      onStderr: (chunk) => {
        if (chunk.includes('[ssh]')) {
          process.stderr.write(chunk)
        }
      }
    })
    app = updated.app
    await waitForSessionReady(updated.page)
    // Why connect, not disconnect first: on launch the app already reaches the server through its
    // tunnel, and a disconnect racing that restore cancels the connect that runs the update.
    const attempts: string[] = []
    await expect
      .poll(
        async () => {
          attempts.push(await connectOnce(updated.page, targetId))
          const record = readHostOrcadActivation(host.exec!)
          return record.active !== deployed.active
            ? 'updated'
            : JSON.stringify({ attempts: attempts.slice(-3), record })
        },
        { timeout: 8 * 60_000, intervals: [5_000] }
      )
      .toBe('updated')
    await expect
      .poll(() => managedServer(updated.page, targetId), { timeout: 60_000 })
      .toEqual({ kind: 'managed', environmentId: expect.any(String) })
    const record = readHostOrcadActivation(host.exec!)
    expect(isOrcadFullVersion(record.active)).toBe(true)
    expect(record.previous).toBe(deployed.active)
    expect(record.activeAppVersion).toBeTruthy()
  } finally {
    if (app) {
      await session.close(app)
    }
    await session.dispose()
  }
})

/** One connect; returns its managed-server state, or why it threw, for a poll to report. */
function connectOnce(page: Page, targetId: string): Promise<string> {
  return page.evaluate(async (id) => {
    try {
      const state = await window.api.ssh.connect({ targetId: id })
      return JSON.stringify(state?.managedServer ?? null)
    } catch (error) {
      return `connect threw: ${String(error)}`
    }
  }, targetId)
}

test('reconnect restores the managed host name after its conversion catalog fails', async ({
  testRepoPath
}, testInfo) => {
  test.skip(HOST !== 'docker', 'Catalog fault injection uses the isolated Linux Docker host')
  test.setTimeout(180_000)
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'orca-catalog-retry-'))
  const templateDir = path.join(scratch, 'template')
  const host = startOrcadConvertHost('docker', testInfo)
  const session = createRestartSession(testInfo, { ORCA_ORCAD_TEMPLATE_PATH: templateDir })
  let app: Awaited<ReturnType<typeof session.launch>>['app'] | null = null
  try {
    const first = await session.launch()
    app = first.app
    await waitForSessionReady(first.page)
    // A local project keeps a second host section, so the managed host header renders.
    await first.page.evaluate((repoPath) => window.api.repos.add({ path: repoPath }), testRepoPath)
    await session.close(app)
    app = null
    const seeded = seedRelayEraProfile(session.userDataDir, host.input, {
      repoPath: host.remoteRepoPath,
      folderPath: host.remoteFolderPath
    })
    const relay = await session.launch()
    app = relay.app
    const page = relay.page
    await waitForSessionReady(page)
    await page.evaluate(() => window.__store!.getState().setGroupBy('none'))
    await reconnect(page, seeded.targetId)
    await expect.poll(() => managedServer(page, seeded.targetId)).toMatchObject({ kind: 'relay' })

    // Fail the local catalog IPC during a real SSH migration; healing restores its production handler.
    await app.evaluate(({ ipcMain }) => {
      type Handler = (event: unknown, ...args: unknown[]) => unknown
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Electron's registered invoke handlers are a Map of channel callbacks.
      const registry = (ipcMain as unknown as { _invokeHandlers?: Map<string, Handler> })
        ._invokeHandlers
      const original = registry?.get('runtimeEnvironments:list')
      if (!original) {
        throw new Error('runtimeEnvironments:list is not registered')
      }
      ipcMain.removeHandler('runtimeEnvironments:list')
      ipcMain.handle('runtimeEnvironments:list', () => {
        throw new Error('catalog-retry: managed-host catalog temporarily unavailable')
      })
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this test installs and removes its own recovery callback within this app.
      const state = globalThis as typeof globalThis & { healCatalogFault?: () => void }
      state.healCatalogFault = () => {
        ipcMain.removeHandler('runtimeEnvironments:list')
        ipcMain.handle('runtimeEnvironments:list', original)
      }
    })
    const failure = page.waitForEvent('console', {
      predicate: (message) =>
        message.text().includes('Could not refresh the managed server list') ||
        message.text().includes('Could not load the managed server catalogs')
    })
    cpSync(TEMPLATE_SOURCE!, templateDir, { recursive: true })
    await reconnect(page, seeded.targetId)
    await expect.poll(() => managedServer(page, seeded.targetId)).toMatchObject({ kind: 'managed' })
    await failure
    await page.screenshot({ path: testInfo.outputPath('catalog-failure.png') })

    await app.evaluate(() => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fault installation above owns this optional callback.
      const state = globalThis as typeof globalThis & { healCatalogFault?: () => void }
      state.healCatalogFault?.()
    })
    const environment = (await page.evaluate(() => window.api.runtimeEnvironments.list())).find(
      (entry) => entry.orcadDeployment?.sshTargetId === seeded.targetId
    )
    if (!environment) {
      throw new Error('Managed host missing from main catalog')
    }
    await page.evaluate(
      (id) => window.__store!.setState({ visibleWorkspaceHostIds: ['local', `runtime:${id}`] }),
      environment.id
    )
    await reconnect(page, seeded.targetId)
    // The folder row must retain its managed execution host after the catalog heals.
    const folder = page.locator('[data-worktree-host-identity]').filter({
      has: page.getByText('orcad upgrade folder', { exact: true })
    })
    await expect(folder).toHaveCount(1, { timeout: 30_000 })
    await expect(folder).toHaveAttribute('data-worktree-host-identity', /runtime:/)
    await expect(
      page.locator('[data-host-header-drag-id^="runtime:"]').filter({ hasText: environment.name })
    ).toHaveCount(1)
    await page.screenshot({ path: testInfo.outputPath('catalog-recovered.png') })
  } finally {
    if (app) {
      await session.close(app)
    }
    await session.dispose()
    host.cleanup()
    rmSync(scratch, { recursive: true, force: true })
  }
})
