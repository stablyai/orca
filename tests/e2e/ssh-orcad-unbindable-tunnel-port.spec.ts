// #33182: if the saved tunnel port is excluded or occupied after relaunch, reuse pairing on a fresh port and restore pane input.
import { createServer, type Server } from 'node:net'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { waitForSessionReady, waitForStartupWorktreeRefresh } from './helpers/store'
import {
  activateManagedWorkspace,
  echoMarker,
  expectTerminalAnswers,
  launchManagedWorkspace,
  openTerminalTab,
  selectTerminalTab,
  skipUnlessManagedDockerHost,
  withManagedHost
} from './helpers/orcad-managed-workspace'

skipUnlessManagedDockerHost()
test.skip(process.platform === 'win32', 'The Docker SSH host uses POSIX tooling')

async function managedTunnel(page: Page, environmentId: string) {
  const environment = (await page.evaluate(() => window.api.runtimeEnvironments.list())).find(
    (entry) => entry.id === environmentId
  )
  return {
    localPort: environment?.orcadDeployment?.localPort ?? null,
    pairedDeviceId: environment?.pairedDeviceId ?? null
  }
}

function occupy(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    // Holds the port only; open connections would keep close() waiting through teardown.
    const server = createServer((socket) => socket.destroy())
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}

test('a relaunch whose saved tunnel port is taken moves to a free one and the pane answers', async (// oxlint-disable-next-line no-empty-pattern -- Owns its app launch through a restart session.
{}, testInfo) => {
  test.setTimeout(15 * 60_000)
  const squatters: Server[] = []
  try {
    await withManagedHost(testInfo, async (fixture) => {
      const { page, seeded, environmentId } = await launchManagedWorkspace(fixture)
      const tabId = await openTerminalTab(page, seeded.worktreeId)
      await echoMarker(page, tabId, 'BEFORE_SQUAT')
      const before = await managedTunnel(page, environmentId)
      expect(before.localPort).toBeTruthy()

      await fixture.session.close(fixture.app!)
      fixture.app = null
      // The quit releases the forward's listener; take its port before Orca starts again.
      await expect(async () => {
        squatters.push(await occupy(before.localPort!))
      }).toPass({ timeout: 30_000 })
      const relaunched = await fixture.session.launch()
      fixture.app = relaunched.app
      await waitForSessionReady(relaunched.page)
      await waitForStartupWorktreeRefresh(relaunched.page)

      await activateManagedWorkspace(relaunched.page, seeded.worktreeId, environmentId)
      await selectTerminalTab(relaunched.page, tabId)
      await expectTerminalAnswers(relaunched.page, tabId, 4 * 60_000)
      const after = await managedTunnel(relaunched.page, environmentId)
      expect(after.localPort).not.toBe(before.localPort)
      expect(after.pairedDeviceId).toBe(before.pairedDeviceId)
      await relaunched.page.screenshot({ path: testInfo.outputPath('moved-tunnel-port.png') })
    })
  } finally {
    await Promise.all(squatters.map((server) => new Promise((resolve) => server.close(resolve))))
  }
})
