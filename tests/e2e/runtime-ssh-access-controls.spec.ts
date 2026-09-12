import { expect, test } from './helpers/orca-app'
import {
  createEnvironmentFromPairingOffer,
  redactRuntimeEnvironment
} from '../../src/shared/runtime-environments'
import { PAIRING_OFFER_VERSION } from '../../src/shared/pairing'

test.use({ seedTestRepo: false, orcaAppExtraEnv: { ORCA_BACKGROUND_LAUNCH: '1' } })

test('paired-server SSH controls expose retry and cancellation without deployment', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  const environment = redactRuntimeEnvironment(
    createEnvironmentFromPairingOffer({
      id: 'ssh-access-ui',
      name: 'Independent build host',
      now: 1,
      offer: {
        v: PAIRING_OFFER_VERSION,
        endpoint: 'ws://127.0.0.1:1',
        publicKeyB64: 'test-key',
        deviceToken: 'test-token'
      }
    })
  )
  await electronApp.evaluate(({ ipcMain }, saved) => {
    let current = saved
    let linkAttempts = 0
    const replace = (channel: string, handler: Parameters<typeof ipcMain.handle>[1]) => {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, handler)
    }
    replace('runtimeEnvironments:list', () => [current])
    replace('runtimeEnvironments:getStatus', () => ({
      id: 'status',
      ok: false,
      error: { code: 'runtime_unavailable', message: 'UI fixture host is offline' },
      _meta: { runtimeId: null }
    }))
    replace('ssh:listTargets', () => [
      {
        id: 'ssh-ui',
        label: 'Build host SSH',
        host: '127.0.0.1',
        port: 22,
        username: 'test',
        generation: 1
      }
    ])
    replace('runtimeEnvironments:linkSshAccess', (_event, args) => {
      linkAttempts += 1
      if (args.selector !== saved.id || args.sshTargetId !== 'ssh-ui' || args.remotePort !== 7779) {
        throw new Error('Unexpected SSH request')
      }
      const pending = current.pendingSshAccessOperation
      if (pending && pending.requestId !== args.requestId) {
        throw new Error('Retry changed its request ID')
      }
      current = {
        ...current,
        pendingSshAccessOperation: {
          operation: 'link',
          requestId: args.requestId,
          sshTargetId: 'ssh-ui',
          sshTargetGeneration: 1,
          remotePort: 7779,
          targetFingerprint: 'fixture'
        }
      }
      if (linkAttempts === 1) {
        throw new Error('SSH verification interrupted; retry or cancel')
      }
      current = {
        ...current,
        pendingSshAccessOperation: undefined,
        sshAccess: {
          sshTargetId: 'ssh-ui',
          sshTargetGeneration: 1,
          remotePort: 7779,
          localPort: 47779,
          endpointId: saved.preferredEndpointId,
          previousPreferredEndpointId: saved.preferredEndpointId,
          requestId: args.requestId
        }
      }
      return current
    })
    replace('runtimeEnvironments:unlinkSshAccess', (_event, args) => {
      if (
        current.pendingSshAccessOperation &&
        args.requestId !== current.pendingSshAccessOperation.requestId
      ) {
        throw new Error('Cancel changed its request ID')
      }
      current = { ...saved }
      return current
    })
  }, environment)
  await orcaPage.evaluate(() => {
    const state = window.__store!.getState()
    state.openSettingsTarget({ pane: 'servers', repoId: null })
    state.openSettingsPage()
  })
  await orcaPage.getByRole('button', { name: 'Remote Orca Servers Beta', exact: true }).click()
  await orcaPage.getByRole('button', { name: 'SSH access', exact: true }).click()
  await orcaPage.getByLabel('SSH target', { exact: true }).click()
  await orcaPage.getByRole('option', { name: 'Build host SSH', exact: true }).click()
  await orcaPage.getByLabel('Server port', { exact: true }).fill('7779')
  await orcaPage.screenshot({
    path: testInfo.outputPath('ssh-access-form.png'),
    animations: 'disabled'
  })
  await orcaPage.getByRole('button', { name: 'Link SSH', exact: true }).click()
  await expect(
    orcaPage.getByRole('alert').filter({ hasText: 'SSH verification interrupted' })
  ).toBeVisible()
  await expect(
    orcaPage.getByRole('button', { name: 'SSH access pending', exact: true })
  ).toBeVisible()
  await expect(orcaPage.getByRole('button', { name: 'Cancel link', exact: true })).toBeEnabled()
  const cdp = await orcaPage.context().newCDPSession(orcaPage)
  await cdp.send('Runtime.evaluate', { expression: 'document.title' })
  await orcaPage.screenshot({
    path: testInfo.outputPath('ssh-access-pending.png'),
    animations: 'disabled'
  })
  await orcaPage.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(
    orcaPage.getByRole('button', { name: 'SSH access pending', exact: true })
  ).toHaveCount(0)
  await orcaPage.getByRole('button', { name: 'SSH access', exact: true }).click()
  await expect(orcaPage.getByRole('button', { name: 'Unlink SSH', exact: true })).toBeEnabled()
  await expect(orcaPage.getByRole('button', { name: 'Unlink SSH', exact: true })).toBeVisible()
  await orcaPage.evaluate(() => document.documentElement.classList.add('dark'))
  await orcaPage.screenshot({
    path: testInfo.outputPath('ssh-access-linked.png'),
    animations: 'disabled'
  })
  await orcaPage.getByRole('button', { name: 'Unlink SSH', exact: true }).click()
  await orcaPage.getByRole('button', { name: 'SSH access', exact: true }).click()
  await expect(orcaPage.getByLabel('SSH target', { exact: true })).toBeVisible()
  await cdp.detach()
})
