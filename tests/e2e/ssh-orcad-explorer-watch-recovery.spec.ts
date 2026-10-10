import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { createRestartSession } from './helpers/orca-restart'
import { startOrcadConvertHost } from './helpers/orcad-convert-host'
import { seedRelayEraProfile } from './helpers/orcad-upgrade-profile'
import { convertAndRetain, serverCall } from './helpers/orcad-convert-flow'
import { waitForSessionReady, waitForStartupWorktreeRefresh } from './helpers/store'
import { dismissTransientAnnouncement } from './helpers/ssh-config-host-picker'
import { toRuntimeExecutionHostId } from '../../src/shared/execution-host'
import { folderWorkspaceKey } from '../../src/shared/workspace-scope'

const TEMPLATE = process.env.ORCA_E2E_ORCAD_CONVERT_TEMPLATE
test.skip(!TEMPLATE || process.env.ORCA_E2E_SSH_DOCKER !== '1', 'Needs Docker and server template')

function captureRendererMessages(page: Page): void {
  page.on('console', (message) => {
    if (
      message.type() === 'error' ||
      message.type() === 'warning' ||
      message.text().startsWith('[file-change-event]')
    ) {
      console.log('[renderer-event]', message.text())
    }
  })
}

for (const workspace of ['worktree', 'folder'] as const) {
  test(`remote ${workspace} explorer receives host-created files after server restart`, async (// oxlint-disable-next-line no-empty-pattern -- This exercise owns its app launch.
  {}, testInfo) => {
    test.setTimeout(5 * 60_000)
    const host = startOrcadConvertHost('docker', testInfo)
    const session = createRestartSession(testInfo, { ORCA_ORCAD_TEMPLATE_PATH: TEMPLATE! })
    let app: ElectronApplication | null = null
    try {
      if (!host.exec) {
        throw new Error('Docker controls are unavailable')
      }
      const execute = host.exec
      const first = await session.launch()
      app = first.app
      await waitForSessionReady(first.page)
      await session.close(app)
      app = null
      const folderPath = '/tmp/orca-explorer-folder'
      execute(`mkdir -p '${folderPath}'`)
      const seeded = seedRelayEraProfile(session.userDataDir, host.input, {
        repoPath: host.remoteRepoPath,
        folderPath
      })
      const launched = await session.launch()
      app = launched.app
      captureRendererMessages(launched.page)
      await waitForSessionReady(launched.page)
      await convertAndRetain(launched.page, session.userDataDir, seeded)
      const environment = (
        await launched.page.evaluate(() => window.api.runtimeEnvironments.list())
      ).find((entry) => entry.orcadDeployment?.sshTargetId === seeded.targetId)
      if (!environment) {
        throw new Error('Missing managed environment')
      }
      await session.close(app)
      app = null
      const restarted = await session.launch()
      app = restarted.app
      const page = restarted.page
      captureRendererMessages(page)
      await waitForSessionReady(page)
      await waitForStartupWorktreeRefresh(page)
      const folderId = await page.evaluate(
        (path) =>
          window.__store?.getState().folderWorkspaces.find((folder) => folder.folderPath === path)
            ?.id,
        folderPath
      )
      if (!folderId) {
        throw new Error('Converted folder workspace was not restored')
      }
      const worktreeId = workspace === 'folder' ? folderWorkspaceKey(folderId) : seeded.worktreeId
      const rootPath = workspace === 'folder' ? folderPath : host.remoteRepoPath
      await page.evaluate(
        ({ id, hostId }) => window.__store?.getState().setActiveWorktree(id, hostId),
        { id: worktreeId, hostId: toRuntimeExecutionHostId(environment.id) }
      )
      await dismissTransientAnnouncement(page)
      await page.evaluate(() => {
        window.addEventListener('orca:worktree-file-change', (event) => {
          if (event instanceof CustomEvent) {
            console.log('[file-change-event]', JSON.stringify(event.detail))
          }
        })
      })
      const ready = page.waitForEvent('console', {
        predicate: (message) =>
          message.text().startsWith('[file-change-event]') &&
          message.text().includes('WATCH_READY.txt'),
        timeout: 30_000
      })
      execute(`printf 'ready\n' > '${rootPath}/WATCH_READY.txt'`)
      await ready
      await expect(page.getByText('WATCH_READY.txt', { exact: true })).toBeVisible({
        timeout: 30_000
      })
      const serverPids = (): string =>
        execute(
          'for f in /root/.orca-remote/orcad-*/.orcad-pid; do pid=$(cat "$f" 2>/dev/null) && kill -0 "$pid" 2>/dev/null && echo "$pid"; done; true'
        ).trim()
      const before = serverPids()
      expect(before).toMatch(/^\d+$/)
      execute('kill -TERM $(cat /root/.orca-remote/orcad-*/.orcad-pid)')
      await expect.poll(serverPids, { timeout: 30_000 }).toBe('')
      execute(`printf 'changed during outage\n' > '${rootPath}/DURING_OUTAGE.txt'`)
      await expect
        .poll(
          () =>
            page.evaluate(
              async ({ id, worktreeId }) => {
                const response = await window.api.runtimeEnvironments.call({
                  selector: id,
                  method: 'files.read',
                  params: { worktree: `id:${worktreeId}`, relativePath: 'DURING_OUTAGE.txt' }
                })
                return response.ok ? JSON.stringify(response.result) : ''
              },
              { id: environment.id, worktreeId }
            ),
          { timeout: 180_000 }
        )
        .toContain('changed during outage')
      console.log(
        '[managed-server-restart]',
        JSON.stringify({ before, after: serverPids(), workspace, worktreeId })
      )
      const resumed = page.waitForEvent('console', {
        predicate: (message) =>
          message.text().startsWith('[file-change-event]') &&
          message.text().includes('WATCH_RECOVERED.txt'),
        timeout: 30_000
      })
      execute(`printf 'watcher recovered\n' > '${rootPath}/WATCH_RECOVERED.txt'`)
      const created = await serverCall(page, environment.id, 'files.read', {
        worktree: `id:${worktreeId}`,
        relativePath: 'WATCH_RECOVERED.txt'
      })
      console.log('[host-post-restart-file]', created)
      expect(created).toContain('watcher recovered')
      await resumed
      console.log('[recovered-broker-event]', 'WATCH_RECOVERED.txt')
      await page.screenshot({ path: testInfo.outputPath('remote-explorer-observed.png') })
      await expect(page.getByText('DURING_OUTAGE.txt', { exact: true })).toBeVisible({
        timeout: 10_000
      })
      await expect(page.getByText('WATCH_RECOVERED.txt', { exact: true })).toBeVisible({
        timeout: 10_000
      })
      await page.screenshot({ path: testInfo.outputPath('remote-explorer-refreshed.png') })
    } finally {
      if (app) {
        await session.close(app)
      }
      await session.dispose()
      host.cleanup()
    }
  })
}
