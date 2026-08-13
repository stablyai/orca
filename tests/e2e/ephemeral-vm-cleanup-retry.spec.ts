import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'

test.use({ seedTestRepo: false })

test('shows crash-interrupted hidden SSH cleanup as retryable', async ({
  electronApp,
  orcaPage
}) => {
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
