import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { createRestartSession } from './helpers/orca-restart'
import { startOrcadConvertHost } from './helpers/orcad-convert-host'
import { seedRelayEraProfile } from './helpers/orcad-upgrade-profile'
import { convertAndRetain, serverCall } from './helpers/orcad-convert-flow'
import { waitForSessionReady, waitForStartupWorktreeRefresh } from './helpers/store'
import { dismissTransientAnnouncement } from './helpers/ssh-config-host-picker'
import { toRuntimeExecutionHostId } from '../../src/shared/execution-host'

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

for (const recovery of ['conversion', 'server restart'] as const) {
  test(`remote editors receive host file changes after ${recovery}`, async (// oxlint-disable-next-line no-empty-pattern -- This exercise owns its app launch.
  {}, testInfo) => {
    test.setTimeout(4 * 60_000)
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
      const marker = `REMOTE_MARKDOWN_${Date.now()}`
      execute(
        `printf '# ${marker}\n\nHost-owned Markdown.\n\n[[LATE]]\n' > '${host.remoteRepoPath}/README.md'`
      )
      const seeded = seedRelayEraProfile(session.userDataDir, host.input, {
        repoPath: host.remoteRepoPath,
        folderPath: host.remoteFolderPath
      })
      const launched = await session.launch()
      app = launched.app
      let page = launched.page
      captureRendererMessages(page)
      await waitForSessionReady(page)
      await convertAndRetain(page, session.userDataDir, seeded)
      const environment = (await page.evaluate(() => window.api.runtimeEnvironments.list())).find(
        (e) => e.orcadDeployment?.sshTargetId === seeded.targetId
      )
      if (!environment) {
        throw new Error('Missing managed environment')
      }
      if (recovery === 'server restart') {
        await session.close(app)
        app = null
        const restarted = await session.launch()
        app = restarted.app
        page = restarted.page
        captureRendererMessages(page)
        await waitForSessionReady(page)
        await waitForStartupWorktreeRefresh(page)
      }
      await page.evaluate(
        ({ id, hostId }) => window.__store?.getState().setActiveWorktree(id, hostId),
        {
          id: seeded.worktreeId,
          hostId: toRuntimeExecutionHostId(environment.id)
        }
      )
      await dismissTransientAnnouncement(page)
      await expect(page.locator('.rich-markdown-editor')).toContainText(marker, { timeout: 30_000 })
      await page.evaluate(() => {
        window.addEventListener('orca:worktree-file-change', (event) => {
          if (event instanceof CustomEvent) {
            console.log('[file-change-event]', JSON.stringify(event.detail))
          }
        })
      })
      if (recovery === 'server restart') {
        const ready = page.waitForEvent('console', {
          predicate: (message) =>
            message.text().startsWith('[file-change-event]') &&
            message.text().includes('WATCH_READY.txt'),
          timeout: 30_000
        })
        execute(`printf 'ready\\n' > '${host.remoteRepoPath}/WATCH_READY.txt'`)
        await ready
        const serverPids = (): string =>
          execute(
            'for f in /root/.orca-remote/orcad-*/.orcad-pid; do pid=$(cat "$f" 2>/dev/null) && kill -0 "$pid" 2>/dev/null && echo "$pid"; done; true'
          ).trim()
        const before = serverPids()
        expect(before).toMatch(/^\d+$/)
        execute('kill -TERM $(cat /root/.orca-remote/orcad-*/.orcad-pid)')
        await expect.poll(serverPids, { timeout: 30_000 }).toBe('')
        console.log('[managed-server-terminated]', before)
      }
      const updatedMarker = `UPDATED_${marker}`
      execute(
        `printf '# ${updatedMarker}\\n\\nChanged independently on the execution host.\\n' > '${host.remoteRepoPath}/README.md'`
      )
      if (recovery === 'server restart') {
        await expect
          .poll(
            () =>
              page.evaluate(
                async ({ id, worktreeId }) => {
                  const response = await window.api.runtimeEnvironments.call({
                    selector: id,
                    method: 'files.read',
                    params: { worktree: `id:${worktreeId}`, relativePath: 'README.md' }
                  })
                  return response.ok ? JSON.stringify(response.result) : ''
                },
                { id: environment.id, worktreeId: seeded.worktreeId }
              ),
            { timeout: 180_000 }
          )
          .toContain(updatedMarker)
        console.log(
          '[managed-server-restarted]',
          execute('cat /root/.orca-remote/orcad-*/.orcad-pid').trim()
        )
      }
      const content = await serverCall(page, environment.id, 'files.read', {
        worktree: `id:${seeded.worktreeId}`,
        relativePath: 'README.md'
      })
      console.log('[host-updated-content]', content)
      expect(content).toContain(updatedMarker)
      await page.screenshot({ path: testInfo.outputPath('remote-editor-observed.png') })
      await expect(page.locator('.rich-markdown-editor')).toContainText(updatedMarker, {
        timeout: 15_000
      })
      await page.screenshot({ path: testInfo.outputPath('remote-editor-refreshed.png') })
      if (recovery === 'server restart') {
        const resumed = page.waitForEvent('console', {
          predicate: (message) =>
            message.text().startsWith('[file-change-event]') &&
            message.text().includes('WATCH_RECOVERED.txt'),
          timeout: 15_000
        })
        execute(`printf 'watcher recovered\\n' > '${host.remoteRepoPath}/WATCH_RECOVERED.txt'`)
        const created = await serverCall(page, environment.id, 'files.read', {
          worktree: `id:${seeded.worktreeId}`,
          relativePath: 'WATCH_RECOVERED.txt'
        })
        console.log('[host-post-restart-file]', created)
        expect(created).toContain('watcher recovered')
        await resumed
      }
    } finally {
      if (app) {
        await session.close(app)
      }
      await session.dispose()
      host.cleanup()
    }
  })
}
