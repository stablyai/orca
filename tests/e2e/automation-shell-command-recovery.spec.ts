import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

for (const workspaceMode of ['existing', 'new_per_run'] as const) {
  test(`shell automation retains completion and output across renderer reload in ${workspaceMode}`, async ({
    orcaPage,
    registerPostElectronShutdownCleanup
  }, testInfo) => {
    const fixturePath = mkdtempSync(path.join(os.tmpdir(), 'orca-automation-reload-'))
    registerPostElectronShutdownCleanup(() => rm(fixturePath, { recursive: true, force: true }))
    const counterPath = path.join(fixturePath, 'launches.txt')
    const releasePath = path.join(fixturePath, 'release')
    const finishedPath = path.join(fixturePath, 'finished')
    const scriptPath = path.join(fixturePath, 'command.cjs')
    const startMarker = 'ORCA_SHELL_BEFORE_RELOAD'
    const endMarker = 'ORCA_SHELL_AFTER_RELOAD'
    writeFileSync(
      scriptPath,
      [
        "const fs = require('node:fs')",
        `fs.appendFileSync(${JSON.stringify(counterPath)}, 'launch\\n')`,
        `console.log(${JSON.stringify(startMarker)})`,
        'const timer = setInterval(() => {',
        `  if (!fs.existsSync(${JSON.stringify(releasePath)})) return`,
        '  clearInterval(timer)',
        `  console.log(${JSON.stringify(endMarker)})`,
        `  fs.writeFileSync(${JSON.stringify(finishedPath)}, 'done')`,
        '}, 50)'
      ].join('\n')
    )

    await waitForSessionReady(orcaPage)
    await orcaPage.evaluate(() => {
      const store = window.__store
      if (!store) {
        throw new Error('Store unavailable')
      }
      store.getState().openAutomationsPage()
    })
    await orcaPage.getByRole('button', { name: 'Add new', exact: true }).click()
    const dialog = orcaPage.getByRole('dialog', { name: /^(Create|Edit) automation$/ })
    await dialog.locator('button[data-agent-launch-picker-trigger="true"]').click()
    await orcaPage.getByRole('menuitem', { name: 'Blank Terminal', exact: true }).click()
    const name = `Shell reload ${workspaceMode}`
    await dialog.getByRole('textbox', { name: 'Automation name' }).fill(name)
    if (workspaceMode === 'new_per_run') {
      await dialog.getByRole('radio', { name: 'New run', exact: true }).click()
    }
    const commandEditor = dialog.getByRole('textbox', { name: /^Shell command/ })
    await commandEditor.focus()
    await commandEditor.pressSequentially(`node "${scriptPath}"`)
    await dialog.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(dialog).toBeHidden()
    await orcaPage.getByText(name, { exact: true }).click()
    await orcaPage.getByRole('button', { name: 'Run Now', exact: true }).click()
    await expect.poll(() => existsSync(counterPath), { timeout: 30_000 }).toBe(true)
    await orcaPage.getByRole('tab', { name: /^Runs/ }).click()
    await expect(
      orcaPage.getByRole('tabpanel').getByRole('button', { name: /Launched/ })
    ).toBeVisible()
    await orcaPage.screenshot({ path: testInfo.outputPath('shell-before-reload.png') })

    await orcaPage.reload()
    await waitForSessionReady(orcaPage)
    await orcaPage.evaluate(() => {
      const store = window.__store
      if (!store) {
        throw new Error('Store unavailable after reload')
      }
      store.getState().openAutomationsPage()
    })
    await orcaPage.getByText(name, { exact: true }).click()
    await orcaPage.getByRole('tab', { name: /^Runs/ }).click()
    await expect(
      orcaPage.getByRole('tabpanel').getByRole('button', { name: /Launched/ })
    ).toBeVisible()
    writeFileSync(releasePath, 'finish')
    await expect.poll(() => existsSync(finishedPath)).toBe(true)
    expect(readFileSync(counterPath, 'utf8')).toBe('launch\n')

    await expect(orcaPage.getByText('1 run · 1 completed', { exact: true })).toBeVisible({
      timeout: 30_000
    })
    await orcaPage.getByRole('tabpanel').getByRole('button', { name: /Done/ }).click()
    await expect(orcaPage.getByText(startMarker, { exact: false })).toBeVisible()
    await expect(orcaPage.getByText(endMarker, { exact: false })).toBeVisible()
    expect(readFileSync(counterPath, 'utf8')).toBe('launch\n')
    await orcaPage.screenshot({ path: testInfo.outputPath('shell-after-reload.png') })
  })
}
