import { readFileSync, rmSync } from 'node:fs'
import type { ElectronApplication } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { startOrcadConvertHost } from './helpers/orcad-convert-host'
import { createRestartSession } from './helpers/orca-restart'
import { seedRelayEraProfile } from './helpers/orcad-upgrade-profile'
import { convertAndRetain } from './helpers/orcad-convert-flow'
import { createPairedHostTerminal, openPairedClientTab } from './helpers/paired-host-terminal'
import { focusActiveTerminalInput } from './helpers/terminal'
import { expectTerminalAccessibilityText } from './helpers/terminal-accessibility-tree'
import {
  createRetentionFixtureDirectory,
  writeRetentionFixture
} from './helpers/host-created-terminal-retention-oracle'
import { shellEscape } from '../../src/main/ssh/ssh-connection-utils'
import { startFreezableTcpProxy } from './helpers/freezable-tcp-proxy'

const TEMPLATE = process.env.ORCA_E2E_ORCAD_CONVERT_TEMPLATE
test.skip(
  !TEMPLATE || process.env.ORCA_E2E_SSH_DOCKER !== '1',
  'Needs the Docker SSH host and server template'
)

for (const direction of ['both', 'to-client'] as const) {
  test(`managed host warns about uncertain input when ${direction} traffic stalls`, async (// oxlint-disable-next-line no-empty-pattern -- This test owns both app launches and uses only testInfo.
  {}, testInfo) => {
    test.setTimeout(5 * 60_000)
    const host = startOrcadConvertHost('docker', testInfo)
    const proxy = await startFreezableTcpProxy(host.input.host!, host.input.port ?? 22)
    const input = { ...host.input, port: proxy.port }
    const session = createRestartSession(testInfo, { ORCA_ORCAD_TEMPLATE_PATH: TEMPLATE! })
    const fixtureDirectory = createRetentionFixtureDirectory()
    let app: ElectronApplication | null = null
    let stalled = false
    try {
      if (!host.exec) {
        throw new Error('Docker controls are unavailable')
      }
      const first = await session.launch()
      app = first.app
      await session.close(app)
      app = null
      const seeded = seedRelayEraProfile(session.userDataDir, input, {
        repoPath: host.remoteRepoPath,
        folderPath: host.remoteFolderPath
      })
      const current = await session.launch()
      app = current.app
      const page = current.page
      await convertAndRetain(page, session.userDataDir, seeded)
      const environment = (await page.evaluate(() => window.api.runtimeEnvironments.list())).find(
        (entry) => entry.orcadDeployment?.sshTargetId === seeded.targetId
      )
      if (!environment) {
        throw new Error('Managed host was not registered')
      }
      const fixture = writeRetentionFixture(fixtureDirectory)
      const remoteFixture = '/tmp/orca-half-open-input.mjs'
      const sink = '/tmp/orca-half-open-input.log'
      host.exec(
        `printf '%s' ${shellEscape(readFileSync(fixture, 'utf8'))} > ${shellEscape(remoteFixture)}`
      )
      const terminal = await createPairedHostTerminal(
        page,
        environment.id,
        seeded.worktreeId,
        `node ${shellEscape(remoteFixture)} ${shellEscape(sink)}`
      )
      await openPairedClientTab(page, seeded.worktreeId, terminal.webTabId)
      await expectTerminalAccessibilityText(page, terminal.webTabId, 'READY:')
      await expect(
        page.getByText('Remote terminal input delivery is uncertain', { exact: true })
      ).toBeHidden()
      const runId = Date.now()
      const before = `BEFORE_${runId}`
      const during = `DURING_${runId}`
      const after = `AFTER_${runId}`
      const typeLine = async (line: string): Promise<void> => {
        await focusActiveTerminalInput(page)
        await page.keyboard.type(line)
        await page.keyboard.press('Enter')
      }
      await typeLine(before)
      await expectTerminalAccessibilityText(page, terminal.webTabId, `LINE:${before}`)
      const readState = () =>
        page.evaluate(
          (id) => ({
            ssh: window.__store?.getState().sshConnectionStates.get(id.targetId)?.status,
            runtime: window.__store?.getState().runtimeStatusByEnvironmentId.get(id.environmentId)
              ?.snapshot?.transport
          }),
          { targetId: seeded.targetId, environmentId: environment.id }
        )
      const initially = await readState()
      const start = Date.now()
      if (direction === 'both') {
        proxy.cut('silent')
      } else {
        expect(proxy.freezeExisting('to-client')).toBeGreaterThan(0)
      }
      stalled = true
      await typeLine(during)
      const typedState = await readState()
      await page.screenshot({ path: testInfo.outputPath('half-open-input-typed.png') })
      const warning = page.getByText('Remote terminal input delivery is uncertain', { exact: true })
      await expect(warning).toBeVisible({ timeout: 60_000 })
      const warnedMs = Date.now() - start
      proxy.restore()
      stalled = false
      await expect.poll(readState, { timeout: 120_000 }).toEqual(initially)
      await typeLine(after)
      await expectTerminalAccessibilityText(page, terminal.webTabId, `LINE:${after}`, 60_000)
      const received = host.exec(`cat ${shellEscape(sink)}`)
      const report = {
        warnedMs,
        initially,
        typedState,
        received,
        duringReceived: received.includes(`LINE:${during}`),
        proxyEvents: proxy?.events
      }
      console.log('[half-open-input]', JSON.stringify(report))
      await testInfo.attach('half-open-input-report.json', {
        body: JSON.stringify(report, null, 2),
        contentType: 'application/json'
      })
      await page.screenshot({ path: testInfo.outputPath('half-open-input-recovered.png') })
      expect(received.split('\n').filter((line) => line.startsWith('READY:'))).toHaveLength(1)
      expect(received.split('\n').filter((line) => line === `LINE:${before}`)).toHaveLength(1)
      expect(received.split('\n').filter((line) => line === `LINE:${after}`)).toHaveLength(1)
      expect(received.split('\n').filter((line) => line === `LINE:${during}`)).toHaveLength(
        direction === 'both' ? 0 : 1
      )
      await expect(warning).toBeVisible()
    } finally {
      if (stalled) {
        proxy.restore()
      }
      if (app) {
        await session.close(app)
      }
      await session.dispose()
      await proxy?.close()
      host.cleanup()
      rmSync(fixtureDirectory, { recursive: true, force: true })
    }
  })
}
