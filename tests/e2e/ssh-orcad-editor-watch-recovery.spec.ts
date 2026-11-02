import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { serverCall } from './helpers/orcad-convert-flow'
import {
  activateManagedWorkspace,
  launchConvertedProfile,
  relaunchManagedApp,
  skipUnlessManagedDockerHost,
  withManagedHost
} from './helpers/orcad-managed-workspace'

skipUnlessManagedDockerHost()

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
    await withManagedHost(testInfo, async (fixture) => {
      const { host } = fixture
      if (!host.exec) {
        throw new Error('Docker controls are unavailable')
      }
      const execute = host.exec
      const marker = `REMOTE_MARKDOWN_${Date.now()}`
      execute(
        `printf '# ${marker}\n\nHost-owned Markdown.\n\n[[LATE]]\n' > '${host.remoteRepoPath}/README.md'`
      )
      const converted = await launchConvertedProfile(fixture, { onLaunch: captureRendererMessages })
      const { seeded, environmentId } = converted
      const page =
        recovery === 'server restart'
          ? await relaunchManagedApp(fixture, captureRendererMessages)
          : converted.page
      await activateManagedWorkspace(page, seeded.worktreeId, environmentId)
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
                { id: environmentId, worktreeId: seeded.worktreeId }
              ),
            { timeout: 180_000 }
          )
          .toContain(updatedMarker)
        console.log(
          '[managed-server-restarted]',
          execute('cat /root/.orca-remote/orcad-*/.orcad-pid').trim()
        )
      }
      const content = await serverCall(page, environmentId, 'files.read', {
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
        const created = await serverCall(page, environmentId, 'files.read', {
          worktree: `id:${seeded.worktreeId}`,
          relativePath: 'WATCH_RECOVERED.txt'
        })
        console.log('[host-post-restart-file]', created)
        expect(created).toContain('watcher recovered')
        await resumed
      }
    })
  })
}
