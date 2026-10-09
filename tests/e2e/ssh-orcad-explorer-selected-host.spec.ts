import type { ElectronApplication } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { createRestartSession } from './helpers/orca-restart'
import { startOrcadConvertHost } from './helpers/orcad-convert-host'
import { seedRelayEraProfile, seedRelayEraTarget } from './helpers/orcad-upgrade-profile'
import { mutateStoppedProfileState } from './helpers/persisted-profile-state'
import { convertAndRetain, reconnect, serverCall } from './helpers/orcad-convert-flow'
import { waitForSessionReady, waitForStartupWorktreeRefresh } from './helpers/store'
import { dismissTransientAnnouncement } from './helpers/ssh-config-host-picker'
import { toRuntimeExecutionHostId } from '../../src/shared/execution-host'
import { folderWorkspaceKey } from '../../src/shared/workspace-scope'

const TEMPLATE = process.env.ORCA_E2E_ORCAD_CONVERT_TEMPLATE
test.skip(!TEMPLATE || process.env.ORCA_E2E_SSH_DOCKER !== '1', 'Needs Docker and server template')

for (const selectedHost of ['A', 'B'] as const) {
  test(`same-ID folder explorer follows selected host ${selectedHost}`, async (// oxlint-disable-next-line no-empty-pattern -- This exercise owns its app launch.
  {}, testInfo) => {
    test.setTimeout(5 * 60_000)
    const hostA = startOrcadConvertHost('docker', testInfo)
    const hostB = startOrcadConvertHost('docker', testInfo)
    const session = createRestartSession(testInfo, { ORCA_ORCAD_TEMPLATE_PATH: TEMPLATE! })
    const otherSession = createRestartSession(testInfo, { ORCA_ORCAD_TEMPLATE_PATH: TEMPLATE! })
    let app: ElectronApplication | null = null
    let otherApp: ElectronApplication | null = null
    try {
      if (!hostA.exec || !hostB.exec) {
        throw new Error('Docker controls unavailable')
      }
      const folderPath = '/tmp/orca-same-id-folder'
      hostA.exec(`mkdir -p '${folderPath}' && printf 'initial A\n' > '${folderPath}/INITIAL_A.txt'`)
      hostB.exec(`mkdir -p '${folderPath}' && printf 'initial B\n' > '${folderPath}/INITIAL_B.txt'`)
      const first = await session.launch()
      app = first.app
      await waitForSessionReady(first.page)
      await session.close(app)
      app = null
      const seededA = seedRelayEraProfile(session.userDataDir, hostA.input, {
        repoPath: hostA.remoteRepoPath,
        folderPath
      })
      const initialOther = await otherSession.launch()
      otherApp = initialOther.app
      await waitForSessionReady(initialOther.page)
      await otherSession.close(otherApp)
      otherApp = null
      const seededB = seedRelayEraProfile(otherSession.userDataDir, hostB.input, {
        repoPath: hostB.remoteRepoPath,
        folderPath
      })
      const folderId = mutateStoppedProfileState(session.userDataDir, (state) => {
        if (!Array.isArray(state.folderWorkspaces)) {
          throw new Error('No folder fixture')
        }
        const folder = state.folderWorkspaces.find(
          (entry) => entry.connectionId === seededA.targetId
        )
        if (!folder || typeof folder.id !== 'string') {
          throw new Error('Missing folder owner')
        }
        folder.name = 'Folder host A'
        return folder.id
      })
      mutateStoppedProfileState(otherSession.userDataDir, (state) => {
        if (!Array.isArray(state.folderWorkspaces)) {
          throw new Error('No folder fixture')
        }
        const folder = state.folderWorkspaces.find(
          (entry) => entry.connectionId === seededB.targetId
        )
        if (!folder) {
          throw new Error('Missing other folder owner')
        }
        folder.id = folderId
        folder.name = 'Folder host B'
      })
      const launched = await session.launch()
      app = launched.app
      await waitForSessionReady(launched.page)
      await convertAndRetain(launched.page, session.userDataDir, seededA)
      await session.close(app)
      app = null
      const other = await otherSession.launch()
      otherApp = other.app
      await waitForSessionReady(other.page)
      await convertAndRetain(other.page, otherSession.userDataDir, seededB)
      await otherSession.close(otherApp)
      otherApp = null
      const adoptedTargetId = seedRelayEraTarget(session.userDataDir, hostB.input)
      const restarted = await session.launch()
      app = restarted.app
      const page = restarted.page
      page.on('console', (message) => {
        if (message.text().startsWith('[file-change-event]') || message.type() === 'error') {
          console.log('[renderer]', message.text())
        }
      })
      await waitForSessionReady(page)
      console.log('[adopt-existing-managed-host]', await reconnect(page, adoptedTargetId))
      const environments = await page.evaluate(() => window.api.runtimeEnvironments.list())
      const environmentA = environments.find(
        (entry) => entry.orcadDeployment?.sshTargetId === seededA.targetId
      )
      const environmentB = environments.find(
        (entry) => entry.orcadDeployment?.sshTargetId === adoptedTargetId
      )
      if (!environmentA || !environmentB) {
        throw new Error('Missing converted host')
      }
      console.log(
        '[actual-folder-owners]',
        await serverCall(page, environmentA.id, 'folderWorkspace.list'),
        await serverCall(page, environmentB.id, 'folderWorkspace.list')
      )
      await waitForStartupWorktreeRefresh(page)
      await expect
        .poll(() =>
          page.evaluate(
            (id) =>
              window.__store?.getState().folderWorkspaces.filter((folder) => folder.id === id)
                .length,
            folderId
          )
        )
        .toBe(2)
      await dismissTransientAnnouncement(page)
      await page.evaluate(() => {
        window.addEventListener('orca:worktree-file-change', (event) => {
          if (event instanceof CustomEvent) {
            console.log('[file-change-event]', JSON.stringify(event.detail))
          }
        })
      })
      const worktreeId = folderWorkspaceKey(folderId)
      const [index, environment, host, marker] =
        selectedHost === 'A'
          ? ([0, environmentA, hostA, 'HOST_A_READY.txt'] as const)
          : ([1, environmentB, hostB, 'HOST_B_READY.txt'] as const)
      await page.evaluate(
        ({ id, hostId }) => window.__store?.getState().setActiveFolderWorkspace(id, hostId),
        {
          id: folderId,
          hostId: toRuntimeExecutionHostId(environment.id)
        }
      )
      await expect
        .poll(() => page.evaluate(() => window.__store?.getState().activeWorkspaceExecutionHostId))
        .toBe(toRuntimeExecutionHostId(environment.id))
      await expect(page.getByText(`INITIAL_${selectedHost}.txt`, { exact: true })).toBeVisible()
      await expect(
        page.getByText(`INITIAL_${selectedHost === 'A' ? 'B' : 'A'}.txt`, { exact: true })
      ).toHaveCount(0)
      console.log(
        '[selected-folder-host]',
        index,
        await page.evaluate(() => {
          const state = window.__store?.getState()
          return {
            id: state?.activeWorktreeId,
            host: state?.activeWorkspaceExecutionHostId,
            settingsHost: state?.settings?.activeRuntimeEnvironmentId,
            files: state?.openFiles.map((file) => ({
              id: file.id,
              owner: file.runtimeEnvironmentId
            }))
          }
        })
      )
      const changed = page.waitForEvent('console', {
        predicate: (message) =>
          message.text().startsWith('[file-change-event]') &&
          message.text().includes(marker) &&
          message.text().includes(environment.id),
        timeout: 15_000
      })
      host.exec?.(`printf 'host ${index}\n' > '${folderPath}/${marker}'`)
      console.log(
        '[positive-host-file]',
        await serverCall(page, environment.id, 'files.read', {
          worktree: `id:${worktreeId}`,
          relativePath: marker
        })
      )
      await changed
      await page.screenshot({ path: testInfo.outputPath('selected-host-explorer-observed.png') })
      await expect(page.getByText(marker, { exact: true })).toBeVisible({ timeout: 10_000 })
      await page.screenshot({ path: testInfo.outputPath('selected-host-explorer-refreshed.png') })
      const otherHost = selectedHost === 'A' ? hostB : hostA
      otherHost.exec?.(`printf 'other host\n' > '${folderPath}/OTHER_HOST_ONLY.txt'`)
      await expect(page.getByText('OTHER_HOST_ONLY.txt', { exact: true })).toHaveCount(0)
      host.exec?.(`rm '${folderPath}/${marker}'`)
      await expect(page.getByText(marker, { exact: true })).toHaveCount(0, { timeout: 10_000 })
      await page.screenshot({ path: testInfo.outputPath(`host-${index}-folder-watch.png`) })
    } finally {
      if (app) {
        await session.close(app)
      }
      if (otherApp) {
        await otherSession.close(otherApp)
      }
      await session.dispose()
      await otherSession.dispose()
      hostA.cleanup()
      hostB.cleanup()
    }
  })
}
