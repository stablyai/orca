import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import {
  cleanupDockerSshRelayTarget,
  execDockerSshRelayTargetCommand,
  shellQuote,
  startDockerSshRelayTarget,
  DOCKER_SSH_RELAY_REMOTE_REPO_PATH,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import { ensureTerminalVisible, waitForSessionReady } from './helpers/store'

test.use({ seedTestRepo: false })

test('adopts a recipe-provisioned SSH root without creating a linked worktree', async ({
  orcaPage
}, testInfo) => {
  test.setTimeout(240_000)
  let target: DockerSshRelayTarget | null = null
  const sourceRepo = mkdtempSync(path.join(tmpdir(), 'orca-provisioned-root-source-'))
  try {
    target = startDockerSshRelayTarget(testInfo)
    seedRecipeRepo(sourceRepo, target)
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

    await orcaPage
      .getByRole('option', { name: new RegExp(workspaceName) })
      .click({ button: 'right' })
    await orcaPage.getByRole('menuitem', { name: 'Remove Project from Orca' }).click()
    const removeDialog = orcaPage.getByRole('dialog', { name: 'Remove Project' })
    await expect(removeDialog).toBeVisible()
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

async function addRecipeRepo(page: Parameters<typeof waitForSessionReady>[0], repoPath: string) {
  return page.evaluate(async (pathValue) => {
    const result = await window.api.repos.add({ path: pathValue })
    if ('error' in result) {
      throw new Error(result.error)
    }
    const store = window.__store!
    await store.getState().fetchRepos()
    await store.getState().updateSettings({ experimentalEphemeralVms: true })
    store.getState().setActiveRepo(result.repo.id)
    return result.repo.id
  }, repoPath)
}

function seedRecipeRepo(repoPath: string, target: DockerSshRelayTarget): void {
  const createScript = path.join(repoPath, 'create.sh')
  const destroyScript = path.join(repoPath, 'destroy.sh')
  writeFileSync(
    createScript,
    `#!/usr/bin/env bash
set -euo pipefail
[ "\${ORCA_RECIPE_RESULT_SCHEMA_VERSION:-}" = 2 ]
[ -n "\${ORCA_REPO_URL:-}" ]
[ -n "\${ORCA_REPO_BRANCH:-}" ]
docker exec ${shellQuote(target.containerName)} git -C ${shellQuote(DOCKER_SSH_RELAY_REMOTE_REPO_PATH)} checkout -B "$ORCA_REPO_BRANCH" >&2
node -e 'console.log(JSON.stringify({schemaVersion:2,checkoutMode:"provisioned-root",connection:{type:"ssh",projectRoot:process.argv[1],target:{label:"Docker provisioned root",host:process.argv[2],port:Number(process.argv[3]),username:"root",identityFile:process.argv[4],identitiesOnly:true}}}))' ${shellQuote(DOCKER_SSH_RELAY_REMOTE_REPO_PATH)} ${shellQuote(target.host)} ${target.port} ${shellQuote(target.identityFile)}
`
  )
  writeFileSync(
    destroyScript,
    `#!/usr/bin/env bash
set -euo pipefail
cat >/dev/null
docker rm -f ${shellQuote(target.containerName)} >/dev/null
`
  )
  chmodSync(createScript, 0o755)
  chmodSync(destroyScript, 0o755)
  writeFileSync(
    path.join(repoPath, 'orca.yaml'),
    `environmentRecipes:
  - id: docker-provisioned-root
    name: Docker provisioned root
    checkoutMode: provisioned-root
    create: ./create.sh
    destroy: ./destroy.sh
`
  )
  execFileSync('git', ['init'], { cwd: repoPath })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: repoPath })
  execFileSync('git', ['config', 'user.name', 'Orca E2E'], { cwd: repoPath })
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/stablyai/orca.git'], {
    cwd: repoPath
  })
  execFileSync('git', ['add', '.'], { cwd: repoPath })
  execFileSync('git', ['commit', '-m', 'seed recipe'], { cwd: repoPath })
}
