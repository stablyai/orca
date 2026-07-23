import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

function hashDockerFixtureDirectory(fixtureDir: string): string {
  const hash = createHash('sha256')
  const pending = [fixtureDir]
  while (pending.length > 0) {
    const directory = pending.pop()
    if (!directory) {
      continue
    }
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    )) {
      const absolutePath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        pending.push(absolutePath)
        continue
      }
      const relativePath = path.relative(fixtureDir, absolutePath).split(path.sep).join('/')
      hash.update(relativePath)
      hash.update('\0')
      hash.update(readFileSync(absolutePath))
      hash.update('\0')
    }
  }
  return hash.digest('hex').slice(0, 16)
}

function fixtureImage(root: string): string {
  const fixtureDir = path.join(root, 'tests', 'e2e', 'fixtures', 'docker-ssh-relay')
  const digest = hashDockerFixtureDirectory(fixtureDir)
  return `orca-e2e-ssh-relay:${digest}`
}

export function getDockerSshRelayImage(): string {
  return process.env.ORCA_E2E_SSH_DOCKER_IMAGE ?? fixtureImage(process.cwd())
}

export function prepareDockerSshRelayImage(root: string): void {
  if (process.env.ORCA_E2E_SSH_DOCKER_IMAGE) {
    return
  }
  const fixtureDir = path.join(root, 'tests', 'e2e', 'fixtures', 'docker-ssh-relay')
  const image = fixtureImage(root)
  execFileSync(
    'docker',
    ['build', '--tag', image, '--file', path.join(fixtureDir, 'Dockerfile'), fixtureDir],
    { stdio: 'inherit', timeout: 300_000 }
  )
}
