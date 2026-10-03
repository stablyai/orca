/**
 * A relay-era SSH host converts to managed orcad on connect (#24979), on a real host:
 *
 * 1. Without an orcad template the connect keeps the relay, so the host gains relay-era state: a
 *    repository, a folder workspace, an editor tab, and a relay terminal that has exited.
 * 2. With the template in place and no relay terminal running, the next connect converts it, and
 *    the new server lists that repository and folder (the editor tab is logged, not yet asserted).
 * 3. The source rows stay retained (downgrade safety) until `orcad-source-retirement` is on; the
 *    connect after that retires them while the server keeps serving the host.
 *
 * Host: `ORCA_E2E_ORCAD_CONVERT_HOST=docker` (Linux fixture) or a Windows host-cell descriptor.
 * Template: `ORCA_E2E_ORCAD_CONVERT_TEMPLATE`, built for that host's target.
 */
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ElectronApplication } from '@stablyai/playwright-test'
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
import { convertThenRetire, managedServer, targetLeases } from './helpers/orcad-convert-flow'
import { seedRelayEraProfile } from './helpers/orcad-upgrade-profile'
import { ORCAD_CONVERT_HOST_ENV, startOrcadConvertHost } from './helpers/orcad-convert-host'
import { toSshExecutionHostId } from '../../src/shared/execution-host'

const HOST = process.env[ORCAD_CONVERT_HOST_ENV]
const TEMPLATE_SOURCE = process.env.ORCA_E2E_ORCAD_CONVERT_TEMPLATE
// Fixed per worker so the app's launch env can name them before the test runs.
const SCRATCH = path.join(os.tmpdir(), `orca-orcad-convert-${process.pid}`)
const TEMPLATE_DIR = path.join(SCRATCH, 'orcad-template')
const FLAGS_FILE = path.join(SCRATCH, 'rollout-flags.json')

test.use({
  orcaAppExtraEnv: {
    ORCA_ORCAD_TEMPLATE_PATH: TEMPLATE_DIR,
    ORCA_E2E_ROLLOUT_FLAGS_FILE: FLAGS_FILE
  }
})

test('a relay host converts to managed orcad on connect, keeps its source, then retires it', async ({
  orcaPage: page,
  electronApp
}, testInfo) => {
  test.skip(
    !HOST || !TEMPLATE_SOURCE,
    `Set ${ORCAD_CONVERT_HOST_ENV} and ORCA_E2E_ORCAD_CONVERT_TEMPLATE`
  )
  // Why Docker only: a relay era without the template needs host Node, which the Windows lane hides.
  test.skip(HOST !== 'docker', 'The runtime relay era runs on the Docker host only')
  test.setTimeout(20 * 60_000)
  rmSync(SCRATCH, { recursive: true, force: true })
  mkdirSync(SCRATCH, { recursive: true })
  writeFileSync(FLAGS_FILE, '{}')
  const host = startOrcadConvertHost(HOST!, testInfo)
  try {
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
    // A shell that starts after the checks above still blocks the gate; settle, then look again.
    await page.waitForTimeout(5_000)
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
    await convertThenRetire(
      page,
      userData,
      {
        targetId: remote.targetId,
        worktreeId: remote.worktreeId,
        repoPath: host.remoteRepoPath,
        folderPath
      },
      FLAGS_FILE
    )
  } finally {
    host.cleanup()
    if (existsSync(SCRATCH)) {
      rmSync(SCRATCH, { recursive: true, force: true })
    }
  }
})

test('a relay-era profile converts its SSH host on the first connect after upgrading', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
{}, testInfo) => {
  test.skip(
    !HOST || !TEMPLATE_SOURCE,
    `Set ${ORCAD_CONVERT_HOST_ENV} and ORCA_E2E_ORCAD_CONVERT_TEMPLATE`
  )
  test.setTimeout(20 * 60_000)
  rmSync(SCRATCH, { recursive: true, force: true })
  mkdirSync(SCRATCH, { recursive: true })
  writeFileSync(FLAGS_FILE, '{}')
  const host = startOrcadConvertHost(HOST!, testInfo)
  const session = createRestartSession(testInfo, {
    ORCA_ORCAD_TEMPLATE_PATH: TEMPLATE_SOURCE!,
    ORCA_E2E_ROLLOUT_FLAGS_FILE: FLAGS_FILE
  })
  let app: ElectronApplication | null = null
  try {
    // The first launch only establishes the profile the relay-era rows are written into.
    const first = await session.launch()
    app = first.app
    await waitForSessionReady(first.page)
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
    await convertThenRetire(upgraded.page, session.userDataDir, seeded, FLAGS_FILE)
  } finally {
    if (app) {
      await session.close(app)
    }
    await session.dispose()
    host.cleanup()
    if (existsSync(SCRATCH)) {
      rmSync(SCRATCH, { recursive: true, force: true })
    }
  }
})
