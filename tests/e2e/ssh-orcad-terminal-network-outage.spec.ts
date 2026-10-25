/**
 * #25783 on the managed-server path: an open pane on an orcad-managed SSH host answers typing again
 * on its own after the network to the host goes away for 30 s and comes back. Nobody clicks
 * Reconnect, and the pane keeps its original shell.
 */
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { readPairedPaneContent } from './helpers/paired-host-terminal'
import { startFreezableTcpProxy, type FreezableTcpProxy } from './helpers/freezable-tcp-proxy'
import {
  echoMarker,
  expectPaneText,
  expectTerminalAnswers,
  launchManagedWorkspace,
  openTerminalTab,
  skipUnlessManagedDockerHost,
  typeInTerminal,
  withManagedHost
} from './helpers/orcad-managed-workspace'

skipUnlessManagedDockerHost()
test.skip(process.platform === 'win32', 'The Docker SSH host uses POSIX tooling')

const OUTAGES = [
  { mode: 'silent', ms: 30_000, label: '30 s' },
  { mode: 'reset', ms: 30_000, label: '30 s' }
] as const

function sshStatus(page: Page, targetId: string): Promise<string | null> {
  return page.evaluate(
    (id) => window.__store?.getState().sshConnectionStates.get(id)?.status ?? null,
    targetId
  )
}

for (const { mode, ms, label } of OUTAGES) {
  test(`a managed pane answers typing again after a ${label} ${mode} network outage`, async (// oxlint-disable-next-line no-empty-pattern -- Owns its app launch through a restart session.
  {}, testInfo) => {
    test.setTimeout(ms + 10 * 60_000)
    let proxy: FreezableTcpProxy | undefined
    try {
      await withManagedHost(testInfo, async (fixture) => {
        const { host } = fixture
        proxy = await startFreezableTcpProxy(host.input.host, host.input.port ?? 22)
        // Why the proxy: the profile reaches sshd only through it, so cutting it is the network.
        host.input = { ...host.input, port: proxy.port }
        const { page, seeded } = await launchManagedWorkspace(fixture)
        const tabId = await openTerminalTab(page, seeded.worktreeId)
        // Quoted apart so the typed command line itself never matches.
        await typeInTerminal(page, tabId, "echo SHELL''_PID=$$")
        await expect
          .poll(async () => /SHELL_PID=(\d+)/.exec(await readPairedPaneContent(page, tabId))?.[1])
          .toBeTruthy()
        const shellPid = /SHELL_PID=(\d+)/.exec(await readPairedPaneContent(page, tabId))![1]
        const marker = await echoMarker(page, tabId, 'BEFORE_OUTAGE')

        proxy.cut(mode)
        await page.waitForTimeout(ms)
        proxy.restore()

        try {
          await expectTerminalAnswers(page, tabId, 180_000)
        } catch (error) {
          console.log(
            '[outage] evidence',
            JSON.stringify({
              sshStatus: await sshStatus(page, seeded.targetId),
              pane: (await readPairedPaneContent(page, tabId)).slice(-600),
              hostShellAlive: host.exec!(`kill -0 ${shellPid} && echo alive || echo gone`),
              proxyEvents: proxy.events
            })
          )
          await page.screenshot({ path: testInfo.outputPath('after-outage.png') })
          throw error
        }
        await expectPaneText(page, tabId, marker)
        await typeInTerminal(page, tabId, "echo SHELL''_PID=$$")
        await expect
          .poll(
            async () =>
              (await readPairedPaneContent(page, tabId)).split(`SHELL_PID=${shellPid}`).length
          )
          .toBeGreaterThan(2)
      })
    } finally {
      await proxy?.close()
    }
  })
}
