/**
 * E2E: SSH config bulk import (picker "Add all") vs Settings Import re-adopt.
 * Covers plan cases P5, P6, P7, P9. Picker list/filter/select live in
 * ssh-config-host-picker.spec.ts.
 */

import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import {
  buildSshConfigBody,
  configHostRow,
  expectSshHostAbsentFromSettings,
  expectSshHostListedInSettings,
  makeSshConfigHostPrefix,
  openSshConfigHostPicker,
  openSshHostSettings,
  removeSshTargetByAlias,
  removeSshTargetsByPrefix,
  returnToAppShell,
  seedIsolatedSshConfig,
  seedOrcaSshTargetMatchingAlias,
  type SeededSshConfigHost
} from './helpers/ssh-config-host-picker'

// Why: afterEach deletes every target carrying this prefix; workers loading the
// module in the same millisecond must not collide on a shared Date.now().
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
      user: 'ops',
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

/** Import both config hosts via picker, then suppress `alias` (removeTarget tombstone). */
async function importPairThenDeleteAlias(
  page: Page,
  electronApp: ElectronApplication,
  prefix: string,
  aliasToDelete: string
): Promise<{ alpha: SeededSshConfigHost; bravo: SeededSshConfigHost }> {
  const hosts = await seedPairConfig(electronApp, prefix)
  const picker = await openSshConfigHostPicker(page)
  await expect(picker.getByRole('button', { name: 'Add all 2 to Orca' })).toBeEnabled()
  await picker.getByRole('button', { name: 'Add all 2 to Orca' }).click()
  await expect(page.getByText('Added 2 hosts to Orca.')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('dialog', { name: 'Choose from ~/.ssh/config' })).toBeHidden({
    timeout: 10_000
  })
  await expect(page.getByRole('dialog', { name: 'Add SSH host' })).toBeHidden({
    timeout: 10_000
  })
  await removeSshTargetByAlias(page, aliasToDelete)
  return hosts
}

test.describe('SSH config host import (bulk + settings re-adopt)', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
  })

  test.afterEach(async ({ orcaPage }) => {
    await removeSshTargetsByPrefix(orcaPage, HOST_PREFIX).catch(() => undefined)
  })

  // ── P5 ─────────────────────────────────────────────────────────────
  test('P5: already-in-Orca badge, disabled row, and Add all counts only new hosts', async ({
    electronApp,
    orcaPage
  }) => {
    const hosts = await seedPairConfig(electronApp, HOST_PREFIX)
    await seedOrcaSshTargetMatchingAlias(orcaPage, {
      alias: hosts.alpha.alias,
      hostname: hosts.alpha.hostname,
      username: hosts.alpha.user,
      port: hosts.alpha.port
    })

    const picker = await openSshConfigHostPicker(orcaPage)
    const alphaRow = configHostRow(picker, hosts.alpha)
    const bravoRow = configHostRow(picker, hosts.bravo)

    await expect(alphaRow).toBeVisible()
    await expect(alphaRow).toBeDisabled()
    await expect(alphaRow.getByText('In Orca', { exact: true })).toBeVisible()

    await expect(bravoRow).toBeVisible()
    await expect(bravoRow).toBeEnabled()
    await expect(bravoRow.getByText('In Orca', { exact: true })).toHaveCount(0)

    await expect(picker.getByRole('button', { name: 'Add all 1 to Orca' })).toBeEnabled()
    await expect(picker.getByRole('button', { name: 'Add all 2 to Orca' })).toHaveCount(0)
  })

  // ── P6 ─────────────────────────────────────────────────────────────
  test('P6: Add all N to Orca imports new hosts; re-open shows all in Orca', async ({
    electronApp,
    orcaPage
  }) => {
    const hosts = await seedPairConfig(electronApp, HOST_PREFIX)
    const picker = await openSshConfigHostPicker(orcaPage)

    await expect(configHostRow(picker, hosts.alpha)).toBeVisible()
    await expect(configHostRow(picker, hosts.bravo)).toBeVisible()
    await expect(picker.getByRole('button', { name: 'Add all 2 to Orca' })).toBeEnabled()

    await picker.getByRole('button', { name: 'Add all 2 to Orca' }).click()
    await expect(orcaPage.getByText('Added 2 hosts to Orca.')).toBeVisible({ timeout: 15_000 })
    await expect(orcaPage.getByRole('dialog', { name: 'Choose from ~/.ssh/config' })).toBeHidden({
      timeout: 10_000
    })
    await expect(orcaPage.getByRole('dialog', { name: 'Add SSH host' })).toBeHidden({
      timeout: 10_000
    })

    const sshSection = await openSshHostSettings(orcaPage)
    await expectSshHostListedInSettings(sshSection, hosts.alpha)
    await expectSshHostListedInSettings(sshSection, hosts.bravo)

    await returnToAppShell(orcaPage)
    const reopened = await openSshConfigHostPicker(orcaPage)
    await expect(configHostRow(reopened, hosts.alpha)).toBeDisabled()
    await expect(
      configHostRow(reopened, hosts.alpha).getByText('In Orca', { exact: true })
    ).toBeVisible()
    await expect(configHostRow(reopened, hosts.bravo)).toBeDisabled()
    await expect(
      configHostRow(reopened, hosts.bravo).getByText('In Orca', { exact: true })
    ).toBeVisible()
    await expect(reopened.getByRole('button', { name: 'All hosts already in Orca' })).toBeDisabled()
  })

  // ── P7 ─────────────────────────────────────────────────────────────
  test('P7: Add all does not re-adopt deleted config hosts (suppress tombstones)', async ({
    electronApp,
    orcaPage
  }) => {
    const hosts = await importPairThenDeleteAlias(
      orcaPage,
      electronApp,
      HOST_PREFIX,
      `${HOST_PREFIX}-alpha`
    )

    const picker = await openSshConfigHostPicker(orcaPage)
    // Suppressed aliases are omitted from the picker entirely.
    await expect(configHostRow(picker, hosts.alpha)).toHaveCount(0)
    await expect(configHostRow(picker, hosts.bravo)).toBeVisible()
    await expect(
      configHostRow(picker, hosts.bravo).getByText('In Orca', { exact: true })
    ).toBeVisible()
    await expect(picker.getByRole('button', { name: 'All hosts already in Orca' })).toBeDisabled()
    await expect(picker.getByRole('button', { name: /Add all \d+ to Orca/ })).toHaveCount(0)

    await returnToAppShell(orcaPage)
    const sshSection = await openSshHostSettings(orcaPage)
    // Pane auto-syncs without reAdopt — deleted alpha must stay gone.
    await expectSshHostListedInSettings(sshSection, hosts.bravo)
    await expectSshHostAbsentFromSettings(sshSection, hosts.alpha)
  })

  // ── P9 ─────────────────────────────────────────────────────────────
  test('P9: Settings Import re-adopts deleted config hosts', async ({ electronApp, orcaPage }) => {
    const hosts = await importPairThenDeleteAlias(
      orcaPage,
      electronApp,
      HOST_PREFIX,
      `${HOST_PREFIX}-alpha`
    )

    const sshSection = await openSshHostSettings(orcaPage)
    await expectSshHostListedInSettings(sshSection, hosts.bravo)
    await expectSshHostAbsentFromSettings(sshSection, hosts.alpha)

    await sshSection.getByRole('button', { name: 'Import' }).click()
    await expect(orcaPage.getByText(/Synced \d+ servers?/i)).toBeVisible({ timeout: 15_000 })

    await expectSshHostListedInSettings(sshSection, hosts.alpha)
    await expectSshHostListedInSettings(sshSection, hosts.bravo)
  })
})
