// After host-side device removal/restart, re-pair over SSH and restore pane input automatically.
// A changed host key must refuse repair and retain the saved pairing.
import type { Page } from '@stablyai/playwright-test'
import { test } from '../../../desktop/electron-fixtures/orca-app'
import { expect } from '@stablyai/playwright-test'
import { readPairedPaneContent } from '../../../terminal/remote-hosts/paired-host-terminal'
import './orcad-convert-flow'

import '../../network-outages/freezable-tcp-proxy'

import {
  echoMarker,
  expectTerminalAnswers,
  launchManagedWorkspace,
  openTerminalTab,
  skipUnlessManagedDockerHost,
  withManagedHost
} from './orcad-managed-workspace'

skipUnlessManagedDockerHost()
test.skip(process.platform === 'win32', 'The Docker SSH host uses POSIX tooling')

const DEVICES = '/root/.orca/orca-devices.json'

const KILL_ORCAD = 'kill -TERM $(cat /root/.orca-remote/orcad-*/.orcad-pid)'
// Ids only: the rows also hold device tokens, which must stay out of CI logs.
const DEVICE_IDS =
  `node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))` +
  `.map((d)=>d.deviceId).join(","))' ${DEVICES}`

async function pairing(page: Page, environmentId: string) {
  const environment = (await page.evaluate(() => window.api.runtimeEnvironments.list())).find(
    (entry) => entry.id === environmentId
  )
  return {
    revision: environment?.pairingRevision ?? environment?.createdAt ?? null,
    deviceId: environment?.pairedDeviceId ?? null
  }
}

function reconnectBanner(page: Page, tabId: string): Promise<string | null> {
  return page.evaluate((id) => {
    const pane = document.querySelector(`[data-terminal-tab-id="${id}"]`) ?? document
    return (
      pane
        .querySelector('[data-terminal-remote-runtime-reconnect-banner]')
        ?.getAttribute('data-terminal-remote-runtime-reconnect-banner') ?? null
    )
  }, tabId)
}

test('a host that dropped this desktop is paired again over SSH and its pane answers', async (// oxlint-disable-next-line no-empty-pattern -- Owns its app launch through a restart session.
{}, testInfo) => {
  test.setTimeout(15 * 60_000)
  await withManagedHost(testInfo, async (fixture) => {
    const { host } = fixture
    const { page, seeded, environmentId } = await launchManagedWorkspace(fixture)
    const tabId = await openTerminalTab(page, seeded.worktreeId)
    await echoMarker(page, tabId, 'BEFORE_REVOKE')
    const before = await pairing(page, environmentId)
    expect(before.deviceId).toBeTruthy()

    // Host side, as an admin would: remove this desktop's device, then restart the server.
    host.exec!(
      `node -e 'const f=process.argv[1];const fs=require("fs");` +
        `fs.writeFileSync(f,JSON.stringify(JSON.parse(fs.readFileSync(f,"utf8"))` +
        `.filter((d)=>d.deviceId!==process.argv[2])))' ${DEVICES} ${before.deviceId}`
    )
    host.exec!(KILL_ORCAD)
    // Evidence for a revoked row the old server wrote back while stopping.
    console.log('[pairing-repair] device ids after kill', host.exec!(DEVICE_IDS))

    try {
      await expectTerminalAnswers(page, tabId, 4 * 60_000)
    } catch (error) {
      console.log(
        '[pairing-repair] evidence',
        JSON.stringify({
          banner: await reconnectBanner(page, tabId),
          pane: (await readPairedPaneContent(page, tabId)).slice(-600),
          devices: host.exec!(DEVICE_IDS)
        })
      )
      await page.screenshot({ path: testInfo.outputPath('after-revoke.png') })
      throw error
    }
    const after = await pairing(page, environmentId)
    console.log('[pairing-repair] device ids after reconnect', host.exec!(DEVICE_IDS), {
      revoked: before.deviceId,
      paired: after.deviceId
    })
    expect(after.revision).not.toBe(before.revision)
    expect(after.deviceId).not.toBe(before.deviceId)
    await expect.poll(() => reconnectBanner(page, tabId)).toBeNull()
    await page.screenshot({ path: testInfo.outputPath('repaired.png') })
  })
})

// Restart behind the network cut so the first client observation is the refusal from the deliberately staged offer.
