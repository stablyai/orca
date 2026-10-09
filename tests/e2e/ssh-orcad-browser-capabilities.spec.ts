import { writeFileSync } from 'node:fs'
import { expect, test } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import { startOrcadConvertHost } from './helpers/orcad-convert-host'
import { reconnect, serverCall } from './helpers/orcad-convert-flow'
import { runtimeAdvertisesBrowserClientHosting } from '../../src/shared/browser-client-hosting-eligibility'

const TEMPLATE = process.env.ORCA_E2E_ORCAD_CONVERT_TEMPLATE
test.skip(!TEMPLATE || process.env.ORCA_E2E_SSH_DOCKER !== '1', 'Needs Docker and server template')
test.use({ orcaAppExtraEnv: { ORCA_ORCAD_TEMPLATE_PATH: TEMPLATE } })

test('a backendless managed host does not promise client-hosted browser creation', async ({
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
      (entry) => entry.orcadDeployment?.sshTargetId === targetId
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
    expect(runtimeAdvertisesBrowserClientHosting(capabilities)).toBe(false)
    expect(capabilities).not.toContain('browser.clientHost.v1')
    expect(capabilities).not.toContain('browser.tab-create-known-id.v1')
    expect(capabilities).toContain('network.browserTunnel.v1')
    const refused = await page.evaluate(
      (selector) =>
        window.api.runtimeEnvironments.call({ selector, method: 'browser.tabList', params: {} }),
      environment.id
    )
    console.log('[managed-browser-command]', JSON.stringify(refused))
    expect(refused).toMatchObject({ ok: false, error: { code: 'browser_unavailable' } })
    await serverCall(page, environment.id, 'repo.list')
    await reconnect(page, targetId)
    expect(runtimeAdvertisesBrowserClientHosting((await status()).capabilities)).toBe(false)
  } finally {
    target.cleanup()
  }
})
