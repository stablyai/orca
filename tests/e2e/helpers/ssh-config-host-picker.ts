/**
 * Shared helpers for SSH config host picker / import E2E specs.
 * Prefer role/label locators and user-visible copy over ids / data-*.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication, Locator, Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'

export function makeSshConfigHostPrefix(): string {
  return `e2e-ssh-cfg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export type SeededSshConfigHost = {
  alias: string
  hostname: string
  user: string
  port: number
}

export function hostEndpointSummary(
  host: Pick<SeededSshConfigHost, 'user' | 'hostname' | 'port'>
): string {
  return `${host.user}@${host.hostname}:${host.port}`
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function buildSshConfigBody(hosts: SeededSshConfigHost[]): string {
  return hosts
    .map(
      (host) =>
        `Host ${host.alias}\n  HostName ${host.hostname}\n  User ${host.user}\n  Port ${host.port}\n`
    )
    .join('\n')
}

/** Write ~/.ssh/config into the Electron-isolated HOME (same path os.homedir() uses). */
export async function seedIsolatedSshConfig(
  electronApp: ElectronApplication,
  configBody: string
): Promise<string> {
  const home = await electronApp.evaluate(({ app }) => app.getPath('home'))
  const sshDir = path.join(home, '.ssh')
  mkdirSync(sshDir, { recursive: true, mode: 0o700 })
  writeFileSync(path.join(sshDir, 'config'), configBody, { mode: 0o600 })
  return home
}

export async function dismissTransientAnnouncement(page: Page): Promise<void> {
  const maybeLaterButton = page.getByRole('button', { name: 'Maybe Later' })
  const visible = await expect(maybeLaterButton)
    .toBeVisible({ timeout: 1_000 })
    .then(() => true)
    .catch(() => false)
  if (visible) {
    await maybeLaterButton.click()
  }
}

export async function closeSettingsPage(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__store?.getState().closeSettingsPage()
  })
  await expect(page.getByPlaceholder('Search settings'))
    .toBeHidden({ timeout: 5_000 })
    .catch(() => undefined)
}

export async function closeOpenDialogs(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const dialogCount = await page.getByRole('dialog').count()
    if (dialogCount === 0) {
      return
    }
    const dialog = page.getByRole('dialog').last()
    const cancelOrBack = dialog.getByRole('button', { name: /^(Cancel|Back)$/ })
    await ((await cancelOrBack
      .first()
      .isVisible()
      .catch(() => false))
      ? cancelOrBack.first().click()
      : page.keyboard.press('Escape'))
    await expect
      .poll(async () => page.getByRole('dialog').count(), { timeout: 3_000 })
      .toBeLessThan(dialogCount)
      .catch(() => undefined)
  }
}

/** Leave settings / overlays so the main shell (Add Project) is reachable. */
export async function returnToAppShell(page: Page): Promise<void> {
  await closeOpenDialogs(page)
  await closeSettingsPage(page)
  await closeOpenDialogs(page)
}

/** Add Project → Host → Add remote host → Add SSH host → form dialog. */
export async function openAddSshHostDialog(page: Page): Promise<Locator> {
  await returnToAppShell(page)
  await page
    .getByRole('button', { name: /Add Project/i })
    .first()
    .click()
  const addProjectDialog = page.getByRole('dialog', { name: /Add a project/i })
  await expect(addProjectDialog).toBeVisible({ timeout: 10_000 })

  const hostCombobox = addProjectDialog.getByRole('combobox')
  await expect(hostCombobox).toBeVisible()
  await hostCombobox.click()

  // cmdk exposes options; accessible name includes the detail line.
  const addRemoteHostItem = page.getByRole('option', { name: /Add remote host/i })
  await expect(addRemoteHostItem).toBeVisible({ timeout: 5_000 })
  await addRemoteHostItem.click()

  // Nested popover is portaled; name includes the “existing machine over SSH” detail.
  const addSshHostAction = page.getByRole('button', {
    name: /Add SSH host.*existing machine over SSH/i
  })
  await expect(addSshHostAction).toBeVisible({ timeout: 5_000 })
  await addSshHostAction.click()

  const sshDialog = page.getByRole('dialog', { name: 'Add SSH host' })
  await expect(sshDialog).toBeVisible({ timeout: 10_000 })
  await expect(sshDialog.getByRole('heading', { name: 'Add SSH host' })).toBeVisible()
  return sshDialog
}

export async function openSshConfigHostPicker(page: Page): Promise<Locator> {
  const sshDialog = await openAddSshHostDialog(page)
  await sshDialog.getByRole('button', { name: /Fill from ~\/\.ssh\/config/i }).click()
  const pickerDialog = page.getByRole('dialog', { name: 'Choose from ~/.ssh/config' })
  await expect(pickerDialog).toBeVisible({ timeout: 10_000 })
  await expect(
    pickerDialog.getByRole('heading', { name: 'Choose from ~/.ssh/config' })
  ).toBeVisible()
  // Wait past the loading empty-state before asserting host rows.
  await expect(pickerDialog.getByText('Reading ~/.ssh/config…')).toBeHidden({ timeout: 10_000 })
  return pickerDialog
}

/** Settings → SSH pane: section the user sees under the “SSH Hosts” heading. */
export async function openSshHostSettings(page: Page): Promise<Locator> {
  await closeOpenDialogs(page)
  await page.evaluate(() => {
    const state = window.__store?.getState()
    if (!state) {
      throw new Error('store unavailable')
    }
    state.openSettingsTarget({ pane: 'ssh', repoId: null })
    state.openSettingsPage()
  })
  await expect(page.getByPlaceholder('Search settings')).toBeVisible({ timeout: 10_000 })
  await dismissTransientAnnouncement(page)

  const sshSection = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'SSH Hosts' }) })
  await expect(sshSection).toBeVisible({ timeout: 10_000 })
  await expect(sshSection.getByRole('button', { name: 'Import' })).toBeVisible()
  await expect(sshSection.getByRole('button', { name: 'Add Target' })).toBeVisible()
  return sshSection
}

/** Form fields on Add SSH host — labels the user reads. */
export function addSshHostFormFields(dialog: Locator): {
  label: Locator
  host: Locator
  username: Locator
  port: Locator
  identityFile: Locator
} {
  return {
    label: dialog.getByLabel('Label', { exact: true }),
    host: dialog.getByLabel('Host or alias'),
    username: dialog.getByLabel('Username'),
    port: dialog.getByLabel('Port'),
    identityFile: dialog.getByLabel('Identity file')
  }
}

/**
 * Picker row for one config Host: the list button whose accessible name includes
 * the alias and the user@host:port line the user sees.
 */
export function configHostRow(
  pickerDialog: Locator,
  host: Pick<SeededSshConfigHost, 'alias' | 'user' | 'hostname' | 'port'>
): Locator {
  const alias = escapeRegExp(host.alias)
  const endpoint = escapeRegExp(hostEndpointSummary(host))
  return pickerDialog
    .getByRole('list', { name: 'SSH config hosts' })
    .getByRole('button', { name: new RegExp(`${alias}[\\s\\S]*${endpoint}`) })
}

/**
 * Assert a saved host appears in Settings. Card subtitle is
 * `user@host:port • terminal timeout: …`, so match the endpoint as a prefix.
 */
export async function expectSshHostListedInSettings(
  sshSection: Locator,
  host: SeededSshConfigHost
): Promise<void> {
  await expect(sshSection.getByText(host.alias, { exact: true })).toBeVisible({ timeout: 10_000 })
  await expect(
    sshSection.getByText(new RegExp(`^${escapeRegExp(hostEndpointSummary(host))}\\b`))
  ).toBeVisible()
}

export async function expectSshHostAbsentFromSettings(
  sshSection: Locator,
  host: SeededSshConfigHost
): Promise<void> {
  await expect(sshSection.getByText(host.alias, { exact: true })).toHaveCount(0)
  await expect(
    sshSection.getByText(new RegExp(escapeRegExp(hostEndpointSummary(host))))
  ).toHaveCount(0)
}
export async function seedOrcaSshTargetMatchingAlias(
  page: Page,
  args: { alias: string; hostname: string; username?: string; port?: number }
): Promise<string> {
  return page.evaluate(async ({ alias, hostname, username, port }) => {
    const result = await window.api.ssh.addTarget({
      target: {
        label: alias,
        configHost: alias,
        host: hostname,
        port: port ?? 22,
        username: username ?? 'deploy',
        relayGracePeriodSeconds: 60
      }
    })
    window.__store?.getState().recordSshRepoReadoptions(result.repoReadoptions)
    return result.target.id
  }, args)
}

export async function removeSshTargetsByPrefix(page: Page, prefix: string): Promise<void> {
  await page.evaluate(async (labelPrefix) => {
    const targets = (await window.api.ssh.listTargets()) as {
      id: string
      label: string
      configHost?: string
    }[]
    for (const target of targets) {
      const matches =
        target.label.startsWith(labelPrefix) ||
        (target.configHost != null && target.configHost.startsWith(labelPrefix))
      if (!matches) {
        continue
      }
      try {
        await window.api.ssh.removeTarget({ id: target.id })
      } catch {
        // Best-effort cleanup.
      }
    }
  }, prefix)
}

export async function removeSshTargetByAlias(page: Page, alias: string): Promise<void> {
  await page.evaluate(async (hostAlias) => {
    const targets = (await window.api.ssh.listTargets()) as {
      id: string
      label: string
      configHost?: string
    }[]
    const match = targets.find(
      (target) => target.configHost === hostAlias || target.label === hostAlias
    )
    if (!match) {
      throw new Error(`No SSH target for alias ${hostAlias}`)
    }
    await window.api.ssh.removeTarget({ id: match.id })
  }, alias)
}
