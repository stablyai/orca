import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { ElectronApplication, Page, TestInfo } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { createLiveCatalogDockerFixture } from './helpers/orcad-live-catalog-docker-fixture'
import { connectDockerSshRelayTarget } from './helpers/docker-ssh-relay-connection'
import { inspectRetirementProfileDrift } from './helpers/orcad-retirement-profile-diagnostics'
import { captureOrcadMigrationInputDiagnostics } from './helpers/orcad-migration-input-diagnostics'
import { createRestartSession } from './helpers/orca-restart'
import { forceQuitElectronAppForE2E } from './helpers/electron-process-shutdown'
import { assertRestartedOrcadMigration } from './helpers/orcad-migration-restart-assertions'
import {
  focusActiveTerminalInput,
  getTerminalContent,
  waitForActivePanePtyId
} from './helpers/terminal'

test.skip(
  process.env.ORCA_REVIEW_ORCAD_DESKTOP_MIGRATION !== '1',
  'Requires rebuilt desktop/relay and matching Linux Bun orcad artifacts plus Docker'
)
test.use({
  seedTestRepo: false,
  orcaAppExtraEnv: {
    ORCA_BACKGROUND_LAUNCH: '1',
    ORCA_ENABLE_PTY_OWNERSHIP_TRANSFER_MUTATION: '1',
    ORCA_RELAY_PATH: resolve('out', 'relay')
  }
})

async function typeShellCommand(
  page: Page,
  command: string,
  beforeInput?: () => Promise<void>
): Promise<void> {
  await waitForActivePanePtyId(page, 60_000)
  await focusActiveTerminalInput(page)
  if (beforeInput) {
    await beforeInput()
  }
  await page.keyboard.type(command)
  await page.keyboard.press('Enter')
}

async function seedShell(page: Page, token: string): Promise<string> {
  await typeShellCommand(
    page,
    `ORCA_MIGRATION_SECRET=${token}; printf 'SOURCE_%s_%s\\n' "$$" "$ORCA_MIGRATION_SECRET"`
  )
  const pattern = new RegExp(`SOURCE_(\\d+)_${token}`)
  await expect.poll(async () => pattern.test(await getTerminalContent(page))).toBe(true)
  return (await getTerminalContent(page)).match(pattern)![1]
}

async function assertPreservedShell(page: Page, token: string, pid: string): Promise<void> {
  // The probe is issued only after restoration; replayed source output cannot satisfy it.
  const nonce = randomUUID().replaceAll('-', '')
  const capture: {
    diagnostics?: Awaited<ReturnType<typeof captureOrcadMigrationInputDiagnostics>>
  } = {}
  const beforeInput =
    process.env.ORCA_REVIEW_ORCAD_INPUT_DIAGNOSTICS === '1'
      ? async () => {
          capture.diagnostics = await captureOrcadMigrationInputDiagnostics(page)
        }
      : undefined
  try {
    await typeShellCommand(
      page,
      `printf 'DESTINATION_%s_%s_%s\\n' "$$" "$ORCA_MIGRATION_SECRET" '${nonce}'`,
      beforeInput
    )
    await expect
      .poll(() => getTerminalContent(page), { timeout: 30_000 })
      .toContain(`DESTINATION_${pid}_${token}_${nonce}`)
  } finally {
    const diagnostics = capture.diagnostics
    if (diagnostics) {
      await test.info().attach('migration-input-diagnostics', {
        body: JSON.stringify(await diagnostics.evaluate((probe) => probe.finish()), null, 2),
        contentType: 'application/json'
      })
      await diagnostics.dispose()
    }
  }
}

async function runDesktopMigration(
  page: Page,
  electronApp: ElectronApplication,
  testInfo: TestInfo,
  afterMigration?: (verifyShells: (restoredPage: Page) => Promise<void>) => Promise<void>
): Promise<void> {
  const target = process.env.ORCA_REVIEW_ORCAD_TARGET
  if (target !== 'linux-arm64-glibc' && target !== 'linux-x64-glibc') {
    throw new Error('fixture_linux_glibc_target_required')
  }
  const host = await createLiveCatalogDockerFixture({
    sourceOwner: 'desktop',
    relayArtifactDir: resolve('out', 'relay', target.replace('-glibc', '')),
    orcadArtifactDir: resolve(
      process.env.ORCA_REVIEW_ORCAD_ARTIFACT_DIR ?? 'out/orcad-ssh-lifecycle'
    )
  })
  try {
    const source = await connectDockerSshRelayTarget(page, host.target, {
      relayGracePeriodSeconds: 0,
      remotePath: host.seedPaths.repoPath
    })
    const worktreeToken = randomUUID().replaceAll('-', '')
    const worktreePid = await seedShell(page, worktreeToken)
    const folder = await page.evaluate(
      async ({ targetId, folderPath }) => {
        const store = window.__store!
        const group = await window.api.projectGroups.create({
          name: 'Migration folder group',
          parentPath: folderPath,
          connectionId: targetId
        })
        const folder = await window.api.folderWorkspaces.create({
          name: 'Migration folder shell',
          folderPath,
          projectGroupId: group.id,
          connectionId: targetId
        })
        await store.getState().fetchProjectGroups()
        await store.getState().fetchFolderWorkspaces()
        store.getState().setActiveFolderWorkspace(folder.id, `ssh:${encodeURIComponent(targetId)}`)
        const workspaceId = `folder:${folder.id}`
        if (!(store.getState().tabsByWorktree[workspaceId] ?? []).length) {
          store.getState().createTab(workspaceId)
        }
        store.getState().setActiveTabType('terminal')
        return folder
      },
      { targetId: source.targetId, folderPath: host.seedPaths.folderPath }
    )
    const folderToken = randomUUID().replaceAll('-', '')
    const folderPid = await seedShell(page, folderToken)
    const beforePreference = await page.evaluate(() => {
      const settings = window.__store!.getState().settings
      if (!settings) {
        throw new Error('fixture_settings_unavailable')
      }
      return settings.activeRuntimeEnvironmentId
    })
    const destination = await host.destination.start()
    const destinationName = 'Desktop migration destination'
    const environmentId = await page.evaluate(
      async ({ pairingCode, name }) => {
        const result = await window.api.runtimeEnvironments.addFromPairingCode({
          name,
          pairingCode
        })
        const store = window.__store!
        store.getState().setRuntimeEnvironments(await window.api.runtimeEnvironments.list())
        if (!(await store.getState().refreshRuntimeEnvironmentStatus(result.environment.id))) {
          throw new Error('fixture_destination_unreachable')
        }
        store.getState().openSettingsTarget({ pane: 'servers', repoId: null })
        store.getState().openSettingsPage()
        return result.environment.id
      },
      { pairingCode: destination.pairing.url, name: destinationName }
    )
    await page.getByRole('button', { name: 'Remote Orca Servers Beta', exact: true }).click()
    await page.locator('#servers').getByRole('button', { name: 'Advanced', exact: true }).click()
    const section = page.getByRole('region', { name: 'SSH host migration', exact: true })
    await section.getByLabel('Migration destination', { exact: true }).click()
    await page.getByRole('option', { name: destinationName, exact: true }).click()
    await section.getByRole('button', { name: 'Load migration status', exact: true }).click()
    await expect(section).toContainText('No saved host migrations for this server.')
    const sourceLabel = await page.evaluate(async (targetId) => {
      const target = (await window.api.ssh.listTargets()).find((entry) => entry.id === targetId)
      if (!target) {
        throw new Error('fixture_source_target_missing')
      }
      return target.label
    }, source.targetId)
    await section.getByLabel('Source SSH target', { exact: true }).click()
    await page.getByRole('option', { name: sourceLabel, exact: true }).click()
    await section.getByRole('button', { name: 'Start host migration', exact: true }).click()
    await expect(section.getByRole('status')).toHaveCount(0, { timeout: 180_000 })
    if (await section.getByRole('alert').count()) {
      const userData = await electronApp.evaluate(({ app }) => app.getPath('userData'))
      const observedSessions = await page.evaluate(async (targetId) => {
        const hostId = `ssh:${encodeURIComponent(targetId)}` as const
        return { [hostId]: await window.api.session.get(hostId) }
      }, source.targetId)
      await testInfo.attach('migration-profile-drift', {
        body: JSON.stringify(
          await inspectRetirementProfileDrift(userData, observedSessions).catch((error) => ({
            diagnosticError: error instanceof Error ? error.message : 'diagnostic_failed'
          })),
          null,
          2
        ),
        contentType: 'application/json'
      })
      const partitions = await page.evaluate(async (targetId) => {
        const sessions = await Promise.all([
          window.api.session.get('local'),
          window.api.session.get(`ssh:${encodeURIComponent(targetId)}`)
        ])
        return sessions.map(
          ({
            tabsByWorktree,
            terminalLayoutsByTabId,
            terminalPtyIncarnationsByPaneKey,
            remoteSessionIdsByTabId,
            closedTerminalTabTombstonesByTabId
          }) => ({
            tabsByWorktree,
            terminalLayoutsByTabId: Object.fromEntries(
              Object.entries(terminalLayoutsByTabId).map(([id, layout]) => [
                id,
                { root: layout.root, ptyIdsByLeafId: layout.ptyIdsByLeafId }
              ])
            ),
            terminalPtyIncarnationsByPaneKey,
            remoteSessionIdsByTabId,
            closedTerminalTabTombstonesByTabId
          })
        )
      }, source.targetId)
      await testInfo.attach('migration-source-partitions', {
        body: JSON.stringify(partitions, null, 2),
        contentType: 'application/json'
      })
    }
    await expect(section.getByRole('alert')).toHaveCount(0)
    await expect(section).toContainText('Host cutover and source retirement confirmed.', {
      timeout: 180_000
    })
    const migrations = await page.evaluate(
      (selector) => window.api.runtimeEnvironments.listOrcadLiveMigrations({ selector }),
      environmentId
    )
    expect(migrations).toEqual([
      expect.objectContaining({
        sourceSshTargetId: source.targetId,
        phaseEvidence: 'journal-retained',
        sourceRetirement: 'complete',
        receipts: { recorded: 2, total: 2 }
      })
    ])
    await page.screenshot({ path: testInfo.outputPath('desktop-migration-completed.png') })
    await section.getByRole('button', { name: 'Refresh destination catalog', exact: true }).click()
    await expect(section).toContainText('Destination catalog refreshed.')
    await page.evaluate(() => window.__store!.getState().closeSettingsPage())
    const verifyShells = async (page: Page): Promise<void> => {
      await page.evaluate(
        ({ environmentId, worktreeId, repoPath }) => {
          const state = window.__store!.getState()
          if (
            state.getKnownWorktreeById(worktreeId, `runtime:${environmentId}`)?.path !== repoPath
          ) {
            throw new Error('fixture_migrated_worktree_missing_from_destination_catalog')
          }
          if (!state.setActiveWorktree(worktreeId, `runtime:${environmentId}`)) {
            throw new Error('fixture_migrated_worktree_not_activatable')
          }
          if (
            window.__store!.getState().activeWorkspaceExecutionHostId !== `runtime:${environmentId}`
          ) {
            throw new Error('fixture_migrated_worktree_wrong_host')
          }
          state.setActiveTabType('terminal')
        },
        { environmentId, worktreeId: source.worktreeId, repoPath: host.seedPaths.repoPath }
      )
      await assertPreservedShell(page, worktreeToken, worktreePid)
      await page.screenshot({ path: testInfo.outputPath('desktop-migrated-worktree-shell.png') })
      await page.evaluate(
        ({ environmentId, folderId }) => {
          const state = window.__store!.getState()
          state.setActiveFolderWorkspace(folderId, `runtime:${environmentId}`)
          if (
            window.__store!.getState().activeWorkspaceExecutionHostId !== `runtime:${environmentId}`
          ) {
            throw new Error('fixture_migrated_folder_not_activatable')
          }
          state.setActiveTabType('terminal')
        },
        { environmentId, folderId: folder.id }
      )
      await assertPreservedShell(page, folderToken, folderPid)
      await page.screenshot({ path: testInfo.outputPath('desktop-migrated-folder-shell.png') })
      expect(
        await page.evaluate(() => {
          const settings = window.__store!.getState().settings
          if (!settings) {
            throw new Error('fixture_settings_unavailable')
          }
          return settings.activeRuntimeEnvironmentId
        })
      ).toBe(beforePreference)
    }
    await verifyShells(page)
    if (afterMigration) {
      const plan = await page.evaluate(
        (selection) => window.api.runtimeEnvironments.getOrcadLiveMigrationRendererPlan(selection),
        { selector: environmentId, migrationId: migrations[0].migrationId }
      )
      await afterMigration(async (restoredPage) => {
        await assertRestartedOrcadMigration(restoredPage, plan, beforePreference)
        await verifyShells(restoredPage)
      })
    }
  } catch (error) {
    if (!page.isClosed()) {
      await page
        .screenshot({ path: testInfo.outputPath('desktop-migration-before-cleanup.png') })
        .catch(() => {})
    }
    throw error
  } finally {
    await host.dispose()
  }
}

test('desktop migrates its own SSH folder/worktree shells to Bun without restarting them', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  test.setTimeout(420_000)
  await runDesktopMigration(orcaPage, electronApp, testInfo)
})

for (const shutdown of ['restart', 'crash'] as const) {
  test(`completed desktop migration preserves folder/worktree shells across desktop ${shutdown}`, async (// oxlint-disable-next-line no-empty-pattern -- This lifecycle test owns both launches.
  {}, testInfo) => {
    test.setTimeout(600_000)
    const session = createRestartSession(testInfo, {
      ORCA_BACKGROUND_LAUNCH: '1',
      ORCA_TEST_MOCK_KEYCHAIN: '1',
      ORCA_ENABLE_PTY_OWNERSHIP_TRANSFER_MUTATION: '1',
      ORCA_RELAY_PATH: resolve('out', 'relay')
    })
    let currentApp: ElectronApplication | undefined
    let currentPage: Page | undefined
    const launch = async (phase: string) => {
      const launched = await session.launch({
        onStderr: (chunk) => {
          if (process.env.ORCA_E2E_FORWARD_APP_LOGS === '1') {
            process.stderr.write(`[${phase}] ${chunk}`)
          }
        }
      })
      currentApp = launched.app
      currentPage = launched.page
      await launched.page.waitForFunction(
        () => window.__store?.getState().workspaceSessionReady === true,
        null,
        {
          timeout: 60_000
        }
      )
      return launched
    }
    try {
      const first = await launch('migration-before-restart')
      await runDesktopMigration(first.page, first.app, testInfo, async (verifyRestored) => {
        if (shutdown === 'crash') {
          const appProcess = first.app.process()
          await forceQuitElectronAppForE2E(first.app)
          currentApp = undefined
          expect(appProcess.exitCode !== null || appProcess.signalCode !== null).toBe(true)
          if (process.platform !== 'win32') {
            expect(appProcess.signalCode).toBe('SIGKILL')
          }
        } else {
          await session.close(first.app)
        }
        currentApp = undefined
        try {
          const second = await launch('migration-after-restart')
          await verifyRestored(second.page)
          await second.page.screenshot({
            path: testInfo.outputPath('desktop-restart-migrated-shell.png')
          })
        } catch (error) {
          if (currentPage && !currentPage.isClosed()) {
            await currentPage
              .screenshot({ path: testInfo.outputPath('desktop-restart-before-cleanup.png') })
              .catch(() => {})
          }
          throw error
        } finally {
          if (currentApp) {
            await session.close(currentApp)
          }
          currentApp = undefined
        }
      })
    } catch (error) {
      if (currentPage && !currentPage.isClosed()) {
        await currentPage
          .screenshot({ path: testInfo.outputPath('desktop-restart-failure.png') })
          .catch(() => {})
      }
      throw error
    } finally {
      try {
        if (currentApp) {
          await session.close(currentApp)
        }
      } finally {
        await session.dispose()
      }
    }
  })
}
