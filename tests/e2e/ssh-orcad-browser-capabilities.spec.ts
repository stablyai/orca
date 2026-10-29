import { writeFileSync } from 'node:fs'
import { expect, test } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import { startOrcadConvertHost } from './helpers/orcad-convert-host'
import { reconnect, serverCall } from './helpers/orcad-convert-flow'
import { runtimeAdvertisesBrowserClientHosting } from '../../src/shared/browser-client-hosting-eligibility'
import { ORCAD_TEMPLATE, skipUnlessManagedDockerHost } from './helpers/orcad-managed-workspace'
import { getOrcadSshDeployment } from '../../src/shared/runtime-environments'

skipUnlessManagedDockerHost()
test.use({ orcaAppExtraEnv: { ORCA_ORCAD_TEMPLATE_PATH: ORCAD_TEMPLATE ?? '' } })

test('a backendless managed host offers desktop-hosted pages and refuses its own engine', async ({
  orcaPage: page
}, testInfo) => {
  test.setTimeout(3 * 60_000)
  const target = startOrcadConvertHost('docker', testInfo)
  try {
    await waitForSessionReady(page)
    const desktopStatus = await page.evaluate(() => window.api.runtime.getStatus())
    expect(runtimeAdvertisesBrowserClientHosting(desktopStatus.capabilities)).toBe(true)
    const targetId = await page.evaluate(async (input) => {
      const { target } = await window.api.ssh.addTarget({ target: input })
      await window.api.ssh.connect({ targetId: target.id })
      return target.id
    }, target.input)
    const environment = (await page.evaluate(() => window.api.runtimeEnvironments.list())).find(
      (entry) => getOrcadSshDeployment(entry)?.sshTargetId === targetId
    )
    if (!environment) {
      throw new Error('Missing managed environment')
    }
    const status = async (): Promise<{ capabilities: string[]; degradations?: unknown[] }> => {
      const response = await serverCall(page, environment.id, 'status.get')
      writeFileSync(testInfo.outputPath('browser-capability-status.json'), response)
      return JSON.parse(response).result
    }
    await expect
      .poll(async () => (await status()).degradations, { timeout: 30_000 })
      .toContainEqual(
        expect.objectContaining({ code: 'browser_unavailable', reason: 'unconfigured' })
      )
    const capabilities = (await status()).capabilities
    console.log('[managed-browser-capabilities]', JSON.stringify(capabilities))
    // #30731: client pages need no engine on the host, so it can create them for a desktop.
    expect(runtimeAdvertisesBrowserClientHosting(capabilities)).toBe(true)
    expect(capabilities).toContain('browser.tab-create-known-id.v1')
    expect(capabilities).toContain('network.browserTunnel.v1')
    const call = (method: string, params: Record<string, unknown>) =>
      page.evaluate((input) => window.api.runtimeEnvironments.call(input), {
        selector: environment.id,
        method,
        params
      })
    const refused = await call('browser.tabList', {})
    console.log('[managed-browser-command]', JSON.stringify(refused))
    expect(refused).toMatchObject({ ok: false, error: { code: 'browser_unavailable' } })
    // Managed SSH desktops do not host via paired open-url; the host CLI uses its browser bridge instead.
    const openUrl = await call('browser.openUrl', {
      url: 'https://example.org/',
      worktree: 'active'
    })
    console.log('[managed-browser-open-url]', JSON.stringify(openUrl))
    expect(openUrl).toMatchObject({ ok: false, error: { code: 'browser_host_unavailable' } })
    await serverCall(page, environment.id, 'repo.list')
    await reconnect(page, targetId)
    expect(runtimeAdvertisesBrowserClientHosting((await status()).capabilities)).toBe(true)
  } finally {
    target.cleanup()
  }
})
