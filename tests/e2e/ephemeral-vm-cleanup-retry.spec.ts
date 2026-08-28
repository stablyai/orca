import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'

test.use({ seedTestRepo: false })

test('shows interrupted hidden SSH cleanup as retryable', async ({ electronApp, orcaPage }) => {
  const userDataPath = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  writeFileSync(
    path.join(userDataPath, 'orca-ephemeral-vm-runtimes.json'),
    JSON.stringify({
      version: 1,
      runtimes: [
        {
          id: 'runtime-cleanup-retry',
          recipeId: 'cloud-sandbox',
          repoId: 'repo-1',
          workspaceName: 'Interrupted cleanup',
          status: 'cleaned',
          cleanupStatus: 'succeeded',
          connectionMode: 'ssh',
          sshTargetId: 'runtime-ssh-cleanup-retry',
          createdAt: 1,
          updatedAt: 1,
          recipeResult: {
            schemaVersion: 1,
            connection: {
              type: 'ssh',
              projectRoot: '/workspace/repo',
              target: {
                label: 'Cloud VM',
                host: 'vm.example.com',
                port: 22,
                username: 'developer'
              }
            }
          }
        }
      ]
    })
  )

  await orcaPage.evaluate(() => {
    const state = window.__store!.getState()
    state.openSettingsTarget({ pane: 'servers', repoId: null })
    state.openSettingsPage()
  })
  await expect(orcaPage.getByPlaceholder('Search settings')).toBeVisible()
  await orcaPage
    .getByRole('group', { name: 'Remote server workflow' })
    .getByRole('button', { name: /^Cloud VM/ })
    .click()

  const runtimes = orcaPage.locator('[data-settings-section="temporary-vm-runtimes"]')
  await expect(runtimes.getByText('Interrupted cleanup')).toBeVisible()
  await expect(runtimes.getByText('Cleanup failed')).toBeVisible()
  await expect(runtimes.getByRole('button', { name: 'Retry cleanup' })).toBeVisible()
})

test('stops long-running cleanup and keeps it retryable', async ({ electronApp, orcaPage }) => {
  const repoPath = mkdtempSync(path.join(tmpdir(), 'orca-cleanup-stop-'))
  const destroyPath = path.join(repoPath, 'destroy.js')
  const destroyStartedPath = path.join(repoPath, 'destroy-started.txt')
  try {
    writeFileSync(
      destroyPath,
      `require('fs').writeFileSync(${JSON.stringify(destroyStartedPath)}, 'yes'); setInterval(() => {}, 1000)`
    )
    execFileSync('git', ['init'], { cwd: repoPath })
    execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: repoPath })
    execFileSync('git', ['config', 'user.name', 'Orca E2E'], { cwd: repoPath })
    writeFileSync(path.join(repoPath, 'README.md'), 'cleanup stop fixture\n')
    execFileSync('git', ['add', '.'], { cwd: repoPath })
    execFileSync('git', ['commit', '-m', 'seed'], { cwd: repoPath })

    const repoId = await orcaPage.evaluate(async (repo) => {
      const result = await window.api.repos.add({ path: repo })
      if ('error' in result) {
        throw new Error(result.error)
      }
      return result.repo.id
    }, repoPath)
    const userDataPath = await electronApp.evaluate(({ app }) => app.getPath('userData'))
    writeFileSync(
      path.join(userDataPath, 'orca-ephemeral-vm-runtimes.json'),
      JSON.stringify({
        version: 1,
        runtimes: [
          {
            id: 'runtime-cleanup-stop',
            recipeId: 'cloud-sandbox',
            recipe: {
              id: 'cloud-sandbox',
              name: 'Cloud Sandbox',
              create: 'unused',
              destroy: `${JSON.stringify(process.execPath)} ${JSON.stringify(destroyPath)}`
            },
            repoId,
            workspaceName: 'Long cleanup',
            status: 'running',
            cleanupStatus: 'not_started',
            createdAt: 1,
            updatedAt: 1,
            recipeResult: {
              schemaVersion: 1,
              connection: {
                type: 'ssh',
                projectRoot: '/workspace/repo',
                target: {
                  label: 'Cloud VM',
                  host: 'vm.example.com',
                  port: 22,
                  username: 'developer'
                }
              }
            }
          }
        ]
      })
    )

    await openCloudVmRuntimes(orcaPage)
    const runtimes = orcaPage.locator('[data-settings-section="temporary-vm-runtimes"]')
    await expect(runtimes.getByText('Long cleanup')).toBeVisible()
    await runtimes.getByRole('button', { name: 'Cleanup', exact: true }).click()
    await expect(runtimes.getByRole('button', { name: 'Stop cleanup' })).toBeVisible()
    await expect.poll(() => existsSync(destroyStartedPath)).toBe(true)

    await runtimes.getByRole('button', { name: 'Stop cleanup' }).click()
    const dialog = orcaPage.getByRole('dialog', { name: 'Stop cleanup?' })
    await expect(dialog).toContainText('The VM may remain running and incur charges.')
    await dialog.getByRole('button', { name: 'Stop cleanup' }).click()

    await expect(dialog).toBeHidden()
    await expect(runtimes.getByText('Cleanup stopped', { exact: true })).toBeVisible()
    await expect(runtimes.getByRole('button', { name: 'Retry cleanup' })).toBeVisible()
    await expect(orcaPage.getByText('Cleanup stopped by user.')).toBeVisible()

    writeFileSync(destroyPath, "process.stdin.resume(); process.stdin.on('end', () => {})")
    await runtimes.getByRole('button', { name: 'Retry cleanup' }).click()
    await expect(runtimes.getByText('Long cleanup')).toBeHidden()
    await expect
      .poll(() =>
        orcaPage.evaluate(async () => {
          const runtime = (await window.api.ephemeralVm.listRuntimes()).find(
            (entry) => entry.id === 'runtime-cleanup-stop'
          )
          return runtime?.cleanupStatus
        })
      )
      .toBe('succeeded')
  } finally {
    rmSync(repoPath, { recursive: true, force: true })
  }
})

async function openCloudVmRuntimes(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window.__store!.getState()
    state.openSettingsTarget({ pane: 'servers', repoId: null })
    state.openSettingsPage()
  })
  await expect(page.getByPlaceholder('Search settings')).toBeVisible()
  await page
    .getByRole('group', { name: 'Remote server workflow' })
    .getByRole('button', { name: /^Cloud VM/ })
    .click()
}
