import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { ensureDockerSshRelayImage } from './helpers/docker-ssh-relay-image'
import {
  cleanupDockerSshRelayTarget,
  execDockerSshRelayTargetCommand,
  shellQuote,
  startDockerSshRelayTarget,
  DOCKER_SSH_RELAY_REMOTE_REPO_PATH,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import { ensureTerminalVisible, waitForSessionReady } from './helpers/store'
import { addRecipeRepo, seedRecipeRepo } from './helpers/provisioned-root-recipe-repo'

test.use({ seedTestRepo: false })

test('adopts a recipe-provisioned SSH root without creating a linked worktree', async ({
  orcaPage
}, testInfo) => {
  test.setTimeout(240_000)
  let target: DockerSshRelayTarget | null = null
  const sourceRepo = mkdtempSync(path.join(tmpdir(), 'orca-provisioned-root-source-'))
  try {
    ensureDockerSshRelayImage(process.cwd())
    target = startDockerSshRelayTarget(testInfo)
    const expectedRefHead = seedRecipeRepo(sourceRepo, target)
    await waitForSessionReady(orcaPage)
    const sourceRepoId = await addRecipeRepo(orcaPage, sourceRepo)

    await orcaPage.getByRole('button', { name: 'New workspace', exact: true }).click()
    const dialog = orcaPage.getByRole('dialog', { name: /Create (Workspace|Worktree)/i })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('combobox', { name: 'Run on' }).click()
    await orcaPage.getByRole('option', { name: /Per-Workspace Environment/ }).click()
    await orcaPage
      .getByRole('listbox', { name: 'Per-Workspace Environment' })
      .getByText('Docker provisioned root', { exact: true })
      .click()

    const workspaceName = `provisioned-root-${Date.now()}`
    await dialog.getByPlaceholder(/Type a name/i).fill(workspaceName)
    await dialog.getByRole('button', { name: /Create (Workspace|Worktree)/i }).click()
    const trustDialog = orcaPage.getByRole('dialog', { name: /Run VM recipe/ })
    await expect(trustDialog).toBeVisible()
    await trustDialog.getByRole('button', { name: 'Run hooks' }).click()

    await expect(dialog).toBeHidden({ timeout: 60_000 })
    await expect(orcaPage.getByRole('option', { name: new RegExp(workspaceName) })).toBeVisible({
      timeout: 60_000
    })
    await ensureTerminalVisible(orcaPage)

    const adopted = await orcaPage.evaluate(
      ({ sourceRepoId, workspaceName }) => {
        const state = window.__store!.getState()
        return Object.values(state.worktreesByRepo)
          .flat()
          .find(
            (worktree) => worktree.displayName === workspaceName && worktree.repoId !== sourceRepoId
          )
      },
      { sourceRepoId, workspaceName }
    )
    expect(adopted).toMatchObject({
      path: DOCKER_SSH_RELAY_REMOTE_REPO_PATH,
      isMainWorktree: true,
      ephemeralVmCheckoutMode: 'provisioned-root'
    })
    expect(adopted?.hostId).toMatch(/^ssh:runtime-ssh-/)
    expect(
      execDockerSshRelayTargetCommand(
        target,
        `git -C ${shellQuote(DOCKER_SSH_RELAY_REMOTE_REPO_PATH)} worktree list --porcelain | grep -c '^worktree '`
      )
    ).toBe('1')
    expect(
      execDockerSshRelayTargetCommand(
        target,
        `git -C ${shellQuote(DOCKER_SSH_RELAY_REMOTE_REPO_PATH)} branch --show-current`
      )
    ).toBe(workspaceName)
    expect(
      execDockerSshRelayTargetCommand(
        target,
        `git -C ${shellQuote(DOCKER_SSH_RELAY_REMOTE_REPO_PATH)} rev-parse HEAD`
      )
    ).toBe(expectedRefHead)

    const removeDialog = orcaPage.getByRole('dialog', { name: 'Remove Project' })
    const removeMenuItem = orcaPage.getByRole('menuitem', { name: 'Remove Project from Orca' })
    await expect(async () => {
      await orcaPage
        .getByRole('option', { name: new RegExp(workspaceName) })
        .click({ button: 'right' })
      await expect(removeMenuItem).toBeVisible({ timeout: 1_000 })
      await removeMenuItem.click({ force: true, timeout: 1_000 })
      await expect(removeDialog).toBeVisible({ timeout: 1_000 })
    }).toPass({ timeout: 10_000 })
    await expect(removeDialog).toContainText(
      'Its VM recipe determines whether the environment and its files are permanently deleted.'
    )
    await removeDialog.getByRole('button', { name: 'Remove', exact: true }).click()
    await expect
      .poll(
        () =>
          orcaPage.evaluate(
            (repoId) => window.__store!.getState().repos.some((repo) => repo.id === repoId),
            adopted!.repoId
          ),
        { timeout: 30_000 }
      )
      .toBe(false)
    expect(() => execDockerSshRelayTargetCommand(target, 'true')).toThrow()
  } finally {
    cleanupDockerSshRelayTarget(target)
    rmSync(sourceRepo, { recursive: true, force: true })
  }
})
