import { execFileSync } from 'node:child_process'
import { chmodSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import {
  execDockerSshRelayTargetCommand,
  shellQuote,
  DOCKER_SSH_RELAY_REMOTE_REPO_PATH,
  type DockerSshRelayTarget
} from './docker-ssh-relay-target'

export async function addRecipeRepo(page: Page, repoPath: string) {
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

export function seedRecipeRepo(repoPath: string, target: DockerSshRelayTarget): string {
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
