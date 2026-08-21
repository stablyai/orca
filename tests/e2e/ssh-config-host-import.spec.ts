/**
 * E2E: SSH config bulk import (picker "Add all") vs Settings Import re-adopt.
 * Covers plan cases P5, P6, P7, P9. Picker list/filter/select live in
 * ssh-config-host-picker.spec.ts.
 */

import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/mcode-app'
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
  seedMCodeSshTargetMatchingAlias,
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
  await expect(picker.getByRole('button', { name: 'Add all 2 to MCode' })).toBeEnabled()
  await picker.getByRole('button', { name: 'Add all 2 to MCode' }).click()
  await expect(page.getByText('Added 2 hosts to MCode.')).toBeVisible({ timeout: 15_000 })
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
  test.beforeEach(async ({ mcodePage }) => {
    await waitForSessionReady(mcodePage)
  })

  test.afterEach(async ({ mcodePage }) => {
    await removeSshTargetsByPrefix(mcodePage, HOST_PREFIX).catch(() => undefined)
  })

  // ── P5 ─────────────────────────────────────────────────────────────
  test('P5: already-in-MCode badge, disabled row, and Add all counts only new hosts', async ({
    electronApp,
    mcodePage
  }) => {
    const hosts = await seedPairConfig(electronApp, HOST_PREFIX)
    await seedMCodeSshTargetMatchingAlias(mcodePage, {
      alias: hosts.alpha.alias,
      hostname: hosts.alpha.hostname,
      username: hosts.alpha.user,
      port: hosts.alpha.port
    })

    const picker = await openSshConfigHostPicker(mcodePage)
    const alphaRow = configHostRow(picker, hosts.alpha)
    const bravoRow = configHostRow(picker, hosts.bravo)

    await expect(alphaRow).toBeVisible()
    await expect(alphaRow).toBeDisabled()
    await expect(alphaRow.getByText('In MCode', { exact: true })).toBeVisible()

    await expect(bravoRow).toBeVisible()
    await expect(bravoRow).toBeEnabled()
    await expect(bravoRow.getByText('In MCode', { exact: true })).toHaveCount(0)

    await expect(picker.getByRole('button', { name: 'Add all 1 to MCode' })).toBeEnabled()
    await expect(picker.getByRole('button', { name: 'Add all 2 to MCode' })).toHaveCount(0)
  })

  // ── P6 ─────────────────────────────────────────────────────────────
  test('P6: Add all N to MCode imports new hosts; re-open shows all in MCode', async ({
    electronApp,
    mcodePage
  }) => {
    const hosts = await seedPairConfig(electronApp, HOST_PREFIX)
    const picker = await openSshConfigHostPicker(mcodePage)

    await expect(configHostRow(picker, hosts.alpha)).toBeVisible()
    await expect(configHostRow(picker, hosts.bravo)).toBeVisible()
    await expect(picker.getByRole('button', { name: 'Add all 2 to MCode' })).toBeEnabled()

    await picker.getByRole('button', { name: 'Add all 2 to MCode' }).click()
    await expect(mcodePage.getByText('Added 2 hosts to MCode.')).toBeVisible({ timeout: 15_000 })
    await expect(mcodePage.getByRole('dialog', { name: 'Choose from ~/.ssh/config' })).toBeHidden({
      timeout: 10_000
    })
    await expect(mcodePage.getByRole('dialog', { name: 'Add SSH host' })).toBeHidden({
      timeout: 10_000
    })

    const sshSection = await openSshHostSettings(mcodePage)
    await expectSshHostListedInSettings(sshSection, hosts.alpha)
    await expectSshHostListedInSettings(sshSection, hosts.bravo)

    await returnToAppShell(mcodePage)
    const reopened = await openSshConfigHostPicker(mcodePage)
    await expect(configHostRow(reopened, hosts.alpha)).toBeDisabled()
    await expect(
      configHostRow(reopened, hosts.alpha).getByText('In MCode', { exact: true })
    ).toBeVisible()
    await expect(configHostRow(reopened, hosts.bravo)).toBeDisabled()
    await expect(
      configHostRow(reopened, hosts.bravo).getByText('In MCode', { exact: true })
    ).toBeVisible()
    await expect(reopened.getByRole('button', { name: 'No new hosts to add' })).toBeDisabled()
  })

  // ── P7 ─────────────────────────────────────────────────────────────
  test('P7: Add all does not re-adopt deleted config hosts (suppress tombstones)', async ({
    electronApp,
    mcodePage
  }) => {
    const hosts = await importPairThenDeleteAlias(
      mcodePage,
      electronApp,
      HOST_PREFIX,
      `${HOST_PREFIX}-alpha`
    )

    const picker = await openSshConfigHostPicker(mcodePage)
    // Suppressed aliases stay listed (re-pickable) but never count as new.
    const alphaRow = configHostRow(picker, hosts.alpha)
    await expect(alphaRow).toBeVisible()
    await expect(alphaRow).toBeEnabled()
    await expect(alphaRow.getByText('Removed from MCode', { exact: true })).toBeVisible()
    await expect(alphaRow.getByText('In MCode', { exact: true })).toHaveCount(0)
    await expect(configHostRow(picker, hosts.bravo)).toBeVisible()
    await expect(
      configHostRow(picker, hosts.bravo).getByText('In MCode', { exact: true })
    ).toBeVisible()
    await expect(picker.getByRole('button', { name: 'No new hosts to add' })).toBeDisabled()
    await expect(picker.getByRole('button', { name: /Add all \d+ to MCode/ })).toHaveCount(0)

    await returnToAppShell(mcodePage)
    const sshSection = await openSshHostSettings(mcodePage)
    // Pane auto-syncs without reAdopt — deleted alpha must stay gone.
    await expectSshHostListedInSettings(sshSection, hosts.bravo)
    await expectSshHostAbsentFromSettings(sshSection, hosts.alpha)
  })

  // ── P9 ─────────────────────────────────────────────────────────────
  test('P9: Settings Import re-adopts deleted config hosts', async ({ electronApp, mcodePage }) => {
    const hosts = await importPairThenDeleteAlias(
      mcodePage,
      electronApp,
      HOST_PREFIX,
      `${HOST_PREFIX}-alpha`
    )

    const sshSection = await openSshHostSettings(mcodePage)
    await expectSshHostListedInSettings(sshSection, hosts.bravo)
    await expectSshHostAbsentFromSettings(sshSection, hosts.alpha)

    await sshSection.getByRole('button', { name: 'Import' }).click()
    await expect(mcodePage.getByText(/Synced \d+ servers?/i)).toBeVisible({ timeout: 15_000 })

    await expectSshHostListedInSettings(sshSection, hosts.alpha)
    await expectSshHostListedInSettings(sshSection, hosts.bravo)
  })
})
