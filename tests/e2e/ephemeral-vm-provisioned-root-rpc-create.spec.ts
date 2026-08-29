import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { RuntimeClient } from '../../src/cli/runtime-client'
import { ensureDockerSshRelayImage } from './helpers/docker-ssh-relay-image'
import {
  cleanupDockerSshRelayTarget,
  execDockerSshRelayTargetCommand,
  shellQuote,
  startDockerSshRelayTarget,
  DOCKER_SSH_RELAY_REMOTE_REPO_PATH,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import { addRecipeRepo, seedRecipeRepo } from './helpers/provisioned-root-recipe-repo'
import { waitForSessionReady } from './helpers/store'

test.use({ seedTestRepo: false })

type RpcWorktree = {
  id: string
  repoId: string
  path: string
  branch: string
  hostId?: string
  isMainWorktree: boolean
}

// The CLI's `worktree create --recipe` path: provision the recipe, adopt its SSH root, and tear the
// environment down again on `worktree rm` — all over the runtime RPC, with no composer involved.
test('creates and destroys a recipe-provisioned workspace over the runtime RPC', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  test.setTimeout(240_000)
  let target: DockerSshRelayTarget | null = null
  const sourceRepo = mkdtempSync(path.join(tmpdir(), 'orca-provisioned-root-rpc-source-'))
  try {
    ensureDockerSshRelayImage(process.cwd())
    target = startDockerSshRelayTarget(testInfo)
    const expectedRefHead = seedRecipeRepo(sourceRepo, target)
    await waitForSessionReady(orcaPage)
    const sourceRepoId = await addRecipeRepo(orcaPage, sourceRepo)
    const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
    const client = new RuntimeClient(userDataDir, 120_000, null, null)

    const workspaceName = `rpc-provisioned-root-${Date.now()}`
    const created = await client.call<{ worktree: RpcWorktree }>('worktree.create', {
      repo: `id:${sourceRepoId}`,
      name: workspaceName,
      recipeId: 'docker-provisioned-root',
      noParent: true
    })
    const worktree = created.result.worktree
    expect(worktree).toMatchObject({
      path: DOCKER_SSH_RELAY_REMOTE_REPO_PATH,
      isMainWorktree: true,
      branch: `refs/heads/${workspaceName}`
    })
    expect(worktree.repoId).not.toBe(sourceRepoId)
    expect(worktree.hostId).toMatch(/^ssh:runtime-ssh-/)
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
    expect(
      execDockerSshRelayTargetCommand(
        target,
        `git -C ${shellQuote(DOCKER_SSH_RELAY_REMOTE_REPO_PATH)} worktree list --porcelain | grep -c '^worktree '`
      )
    ).toBe('1')

    await client.call('worktree.rm', {
      worktree: `id:${worktree.id}`,
      ...(worktree.hostId ? { hostId: worktree.hostId } : {}),
      force: true,
      allowUnverifiedPtyStop: true
    })
    // The recipe destroy removed the container, so the SSH target is unreachable.
    expect(() => execDockerSshRelayTargetCommand(target!, 'true')).toThrow()
  } finally {
    cleanupDockerSshRelayTarget(target)
    rmSync(sourceRepo, { recursive: true, force: true })
  }
})
