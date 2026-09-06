import { projectHostSetupProjectionFromRepos } from '../../src/shared/project-host-setup-projection'
import { test, expect } from './helpers/orca-app'
import { KANEO_TASK, installKaneoApiFixture } from './helpers/kaneo-api-fixture'
import {
  connectDockerSshRelayTarget,
  disconnectDockerSshRelayTarget
} from './helpers/docker-ssh-relay-connection'
import { waitForSessionReady } from './helpers/store'

test('Kaneo Smart selection persists on an SSH worktree', async ({
  electronApp,
  orcaPage,
  testRepoPath
}, testInfo) => {
  test.skip(process.env.ORCA_E2E_SSH_LOCALHOST !== '1', 'Requires a disposable localhost SSH host')
  test.skip(
    process.env.ORCA_E2E_SSH_USER !== 'root',
    'The shared SSH fixture uses a root test account'
  )
  await waitForSessionReady(orcaPage)
  await installKaneoApiFixture(electronApp)
  await orcaPage.evaluate(
    (siteUrl) => window.api.kaneo.connect({ siteUrl, apiKey: 'fixture-api-key' }),
    KANEO_TASK.siteUrl
  )
  const remote = await connectDockerSshRelayTarget(
    orcaPage,
    {
      host: process.env.ORCA_E2E_SSH_HOST ?? '127.0.0.1',
      port: Number(process.env.ORCA_E2E_SSH_PORT ?? '22'),
      identityFile: process.env.ORCA_E2E_SSH_IDENTITY_FILE ?? ''
    },
    { remotePath: testRepoPath }
  )
  try {
    // The legacy SSH fixture seeds repo rows; hydrate its project projection for the composer.
    const repos = await orcaPage.evaluate(() => window.__store!.getState().repos)
    const projection = projectHostSetupProjectionFromRepos(repos)
    await orcaPage.evaluate(({ projects, setups }) => {
      window.__store!.setState({ projects, projectHostSetups: setups })
    }, projection)
    await orcaPage.getByRole('button', { name: 'New workspace', exact: true }).click()
    const dialog = orcaPage.getByRole('dialog', { name: /Create (Workspace|Worktree)/i })
    await dialog
      .getByRole('combobox', { name: 'Project', exact: true })
      .fill('Docker SSH Relay E2E')
    await orcaPage.getByRole('option').filter({ hasText: 'Docker SSH Relay E2E' }).click()
    await expect(dialog).toContainText('Docker SSH Relay')
    const input = dialog.locator('[data-workspace-name-input="true"]')
    await input.fill(KANEO_TASK.url)
    await expect(orcaPage.getByRole('status').filter({ hasText: 'rate limiting' })).toBeVisible()
    await orcaPage.getByRole('button', { name: 'Retry', exact: true }).click()
    await expect(orcaPage.getByRole('option').filter({ hasText: KANEO_TASK.title })).toBeVisible()
    await testInfo.attach('kaneo-ssh-resolved.png', {
      body: await orcaPage.screenshot(),
      contentType: 'image/png'
    })
    await input.press('Enter')
    await dialog.getByRole('button', { name: /Create (Workspace|Worktree)/i }).click()
    await expect(dialog).toBeHidden({ timeout: 30_000 })
    await expect
      .poll(() =>
        orcaPage.evaluate(({ repoId, targetId }) => {
          return (
            window.__store
              ?.getState()
              .worktreesByRepo[repoId]?.some(
                (item) =>
                  item.hostId === `ssh:${encodeURIComponent(targetId)}` &&
                  item.linkedWorkItem?.provider === 'kaneo' &&
                  item.linkedWorkItem.title === 'Improve booking confirmation'
              ) ?? false
          )
        }, remote)
      )
      .toBe(true)
    await expect(
      orcaPage.locator('[data-worktree-card-surface="true"]').filter({ hasText: KANEO_TASK.title })
    ).toBeVisible()
  } finally {
    await orcaPage.evaluate(async ({ repoId }) => {
      const state = window.__store?.getState()
      for (const item of state?.worktreesByRepo[repoId] ?? []) {
        if (item.linkedWorkItem?.provider === 'kaneo') {
          await state?.removeWorktree({ id: item.id, executionHostId: item.hostId ?? null }, true)
        }
      }
    }, remote)
    await disconnectDockerSshRelayTarget(orcaPage, remote.targetId)
  }
})
