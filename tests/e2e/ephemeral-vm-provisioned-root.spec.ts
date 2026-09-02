import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

function seedRecipeRepo(repoPath: string, target: DockerSshRelayTarget): string {
  const createScript = path.join(repoPath, 'create.sh')
  const destroyScript = path.join(repoPath, 'destroy.sh')
  writeFileSync(
    createScript,
    `#!/usr/bin/env bash
set -euo pipefail
[ "\${ORCA_RECIPE_RESULT_SCHEMA_VERSION:-}" = 2 ]
[ -n "\${ORCA_REPO_URL:-}" ]
[ -n "\${ORCA_REPO_REF:-}" ]
[ -n "\${ORCA_REPO_REF_HEAD:-}" ]
[ -n "\${ORCA_REPO_BRANCH:-}" ]
docker exec ${shellQuote(target.containerName)} git -C ${shellQuote(DOCKER_SSH_RELAY_REMOTE_REPO_PATH)} cat-file -e "$ORCA_REPO_REF_HEAD^{commit}"
docker exec ${shellQuote(target.containerName)} git -C ${shellQuote(DOCKER_SSH_RELAY_REMOTE_REPO_PATH)} checkout -B "$ORCA_REPO_BRANCH" "$ORCA_REPO_REF_HEAD" >&2
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
  const expectedRefHead = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoPath,
    encoding: 'utf8'
  }).trim()
  execDockerSshRelayTargetCommand(
    target,
    `rm -rf ${shellQuote(DOCKER_SSH_RELAY_REMOTE_REPO_PATH)} && mkdir -p ${shellQuote(DOCKER_SSH_RELAY_REMOTE_REPO_PATH)}`
  )
  execFileSync('docker', [
    'cp',
    `${repoPath}${path.sep}.`,
    `${target.containerName}:${DOCKER_SSH_RELAY_REMOTE_REPO_PATH}`
  ])
  execDockerSshRelayTargetCommand(
    target,
    `chown -R root:root ${shellQuote(DOCKER_SSH_RELAY_REMOTE_REPO_PATH)}`
  )
  return expectedRefHead
}
