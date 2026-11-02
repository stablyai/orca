// Use isolated HOME and real ssh -G for picker P1/P2/P3/P4/P8 plus N3; bulk/re-adopt lives in ssh-config-host-import.spec.ts.

import type { ElectronApplication } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import {
  addSshHostFormFields,
  buildSshConfigBody,
  closeOpenDialogs,
  configHostRow,
  expectSshHostListedInSettings,
  makeSshConfigHostPrefix,
  openSshConfigHostPicker,
  openSshHostSettings,
  removeSshTargetsByPrefix,
  seedIsolatedSshConfig,
  type SeededSshConfigHost
} from './helpers/ssh-config-host-picker'

test.use({ seedTestRepo: false })

// Use unique cleanup prefixes so workers loaded in the same millisecond cannot delete each other’s targets.
const HOST_PREFIX = makeSshConfigHostPrefix()

function pairHosts(prefix: string): { alpha: SeededSshConfigHost; bravo: SeededSshConfigHost } {
  return {
    alpha: {
      alias: `${prefix}-alpha`,
      hostname: `${prefix}-alpha.example.test`,
      user: 'deploy',
      port: 22
    },
    bravo: {
      alias: `${prefix}-bravo`,
      hostname: `${prefix}-bravo.example.test`,
      user: 'alice',
      port: 2222
    }
  }
}

async function seedPairConfig(
  electronApp: ElectronApplication,
  prefix: string
): Promise<{ alpha: SeededSshConfigHost; bravo: SeededSshConfigHost }> {
  const hosts = pairHosts(prefix)
  await seedIsolatedSshConfig(electronApp, buildSshConfigBody([hosts.alpha, hosts.bravo]))
  return hosts
}

test.describe('SSH config host picker', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
  })

  test.afterEach(async ({ orcaPage }) => {
    await closeOpenDialogs(orcaPage).catch(() => undefined)
    await removeSshTargetsByPrefix(orcaPage, HOST_PREFIX).catch(() => undefined)
  })

  test('P3: select host prefills form; Save persists; N3 identity hint', async ({
    electronApp,
    orcaPage
  }) => {
    const prod: SeededSshConfigHost = {
      alias: `${HOST_PREFIX}-prod`,
      hostname: 'prod.example.test',
      user: 'deploy',
      port: 2222
    }
    await seedIsolatedSshConfig(electronApp, buildSshConfigBody([prod]))

    const picker = await openSshConfigHostPicker(orcaPage)
    await configHostRow(picker, prod).click()

    const form = orcaPage.getByRole('dialog', { name: 'Add SSH host' })
    await expect(form.getByRole('heading', { name: 'Add SSH host' })).toBeVisible({
      timeout: 10_000
    })
    const fields = addSshHostFormFields(form)
    await expect(fields.host).toHaveValue(prod.hostname, { timeout: 15_000 })
    await expect(fields.username).toHaveValue(prod.user)
    await expect(fields.port).toHaveValue(String(prod.port))
    await expect(fields.label).toHaveValue(prod.alias)
    await expect(fields.identityFile).toHaveValue('')
    // N3: empty Identity file explains multi-key resolve from config.
    await expect(
      form.getByText(new RegExp(`Left empty on purpose:.*${escapeRegExp(prod.alias)}`, 'i'))
    ).toBeVisible()
    await expect(
      orcaPage.getByText(new RegExp(`Filled from ${escapeRegExp(prod.alias)}`, 'i'))
    ).toBeVisible({ timeout: 5_000 })

    await form.getByRole('button', { name: 'Save' }).click()
    await expect(form).toBeHidden({ timeout: 10_000 })

    // The saved settings card is durable; the success toast is not.
    const sshSection = await openSshHostSettings(orcaPage)
    await expectSshHostListedInSettings(sshSection, prod)
  })

  test('P4: filter narrows host list', async ({ electronApp, orcaPage }) => {
    const hosts = await seedPairConfig(electronApp, HOST_PREFIX)
    const picker = await openSshConfigHostPicker(orcaPage)

    await expect(configHostRow(picker, hosts.alpha)).toBeVisible()
    await expect(configHostRow(picker, hosts.bravo)).toBeVisible()

    const filter = picker.getByRole('textbox', { name: 'Filter hosts…' })
    await filter.fill('bravo')
    // Why: picker debounces filter IPC ~200ms.
    await expect(configHostRow(picker, hosts.bravo)).toBeVisible({ timeout: 5_000 })
    await expect(configHostRow(picker, hosts.alpha)).toHaveCount(0)

    await filter.fill('no-such-host-zzzz')
    await expect(picker.getByText('No matching hosts')).toBeVisible({ timeout: 5_000 })
    await expect(
      picker.getByText('Try another filter, or go back and type manually.')
    ).toBeVisible()
  })
})

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
