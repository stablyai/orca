/**
 * #12547 acceptance: open a repository the size of Orca's own checkout over SSH and list its files.
 *
 * The remote tree is seeded from this repository's real `git ls-files` output, so the payload has
 * the shape that broke: ~22.6k paths averaging 58 characters, whose 20,001-row page serializes to
 * ~1.2MB — past `DISPATCHER_CONTROL_QUEUE_MAX_BYTES`. Both wire directions are exercised over the
 * real relay: a current client, and a client that names no `maxResults` at all.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { expect, test } from './helpers/orca-app'
import { connectDockerSshRelayTarget } from './helpers/docker-ssh-relay-connection'
import {
  cleanupDockerSshRelayTarget,
  copyFileIntoDockerSshRelayTarget,
  execDockerSshRelayTargetCommand,
  shellQuote,
  startDockerSshRelayTarget,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import { ensureDockerSshRelayImage } from './helpers/docker-ssh-relay-image'
import { waitForSessionReady } from './helpers/store'
import { shouldIncludeQuickOpenPath } from '../../src/shared/quick-open-filter'

const RUN_DOCKER_SSH = process.env.ORCA_E2E_SSH_DOCKER === '1'
const REMOTE_REPO_PATH = '/tmp/orca-quick-open-large-listing-repo'
const REMOTE_PATH_LIST = '/tmp/orca-quick-open-large-listing-paths.txt'
/** What the desktop client asks for; a full page is what it reads as "there is more". */
const CLIENT_PAGE_SIZE = 20_001

function thisRepositoryTrackedPaths(): string[] {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
  // Why -z: `git ls-files` C-quotes any path with a special character, which would seed a tree that
  // does not match the one being measured.
  return execFileSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 256
  })
    .split('\0')
    .filter(Boolean)
}

function seedRemoteTree(target: DockerSshRelayTarget, paths: string[]): void {
  const stagingDir = mkdtempSync(path.join(tmpdir(), 'orca-quick-open-large-listing-'))
  try {
    const localList = path.join(stagingDir, 'paths.txt')
    writeFileSync(localList, `${paths.join('\n')}\n`)
    copyFileIntoDockerSshRelayTarget(target, localList, REMOTE_PATH_LIST)
  } finally {
    rmSync(stagingDir, { recursive: true, force: true })
  }
  const seedScript = [
    "const fs = require('fs'), path = require('path')",
    `const list = fs.readFileSync(${JSON.stringify(REMOTE_PATH_LIST)}, 'utf8').split('\\n').filter(Boolean)`,
    'const seen = new Set()',
    'for (const entry of list) {',
    '  const dir = path.dirname(entry)',
    '  if (dir !== "." && !seen.has(dir)) { fs.mkdirSync(dir, { recursive: true }); seen.add(dir) }',
    "  fs.writeFileSync(entry, '')",
    '}'
  ].join(';')
  const encoded = Buffer.from(seedScript, 'utf8').toString('base64')
  execDockerSshRelayTargetCommand(
    target,
    [
      `rm -rf ${shellQuote(REMOTE_REPO_PATH)}`,
      `mkdir -p ${shellQuote(REMOTE_REPO_PATH)}`,
      `cd ${shellQuote(REMOTE_REPO_PATH)}`,
      'git init -q',
      'git config user.email e2e@test.local',
      'git config user.name "Orca Docker SSH E2E"',
      `node -e ${shellQuote(`eval(Buffer.from('${encoded}', 'base64').toString('utf8'))`)}`,
      'git add -A',
      'git commit -q -m "seed monorepo-shaped tree"'
    ].join(' && ')
  )
}

test.skip(!RUN_DOCKER_SSH, 'Set ORCA_E2E_SSH_DOCKER=1 to run the Docker SSH relay lane')

test('lists a monorepo-sized remote workspace, with and without a client page size (#12547)', async ({
  orcaPage
}, testInfo) => {
  test.setTimeout(420_000)
  let target: DockerSshRelayTarget | null = null
  try {
    const trackedPaths = thisRepositoryTrackedPaths()
    expect(trackedPaths.length).toBeGreaterThan(CLIENT_PAGE_SIZE)
    // Why the real predicate rather than a copy of it: Quick Open prunes a few tracked paths on
    // purpose (`.husky/` among them), and a hand-written expectation would go stale the first time
    // that list changes and read as a transport bug.
    const listablePaths = trackedPaths.filter(shouldIncludeQuickOpenPath)
    // Precondition, measured rather than assumed: the page a current client asks for does not fit
    // one control-lane frame, which is the listing that used to be refused outright.
    expect(
      Buffer.byteLength(JSON.stringify(trackedPaths.slice(0, CLIENT_PAGE_SIZE)), 'utf8')
    ).toBeGreaterThan(1024 * 1024)

    ensureDockerSshRelayImage(process.cwd())
    target = startDockerSshRelayTarget(testInfo)
    seedRemoteTree(target, trackedPaths)

    await waitForSessionReady(orcaPage)
    const connected = await connectDockerSshRelayTarget(orcaPage, target, {
      remotePath: REMOTE_REPO_PATH
    })

    const listFiles = async (maxResults?: number): Promise<string[]> =>
      orcaPage.evaluate(
        ({ connectionId, rootPath, maxResults }) =>
          window.api.fs.listFiles({
            rootPath,
            connectionId,
            ...(maxResults === undefined ? {} : { maxResults })
          }),
        { connectionId: connected.targetId, rootPath: REMOTE_REPO_PATH, maxResults }
      )

    const currentClient = await listFiles(CLIENT_PAGE_SIZE)
    expect(currentClient).toHaveLength(CLIENT_PAGE_SIZE)

    // Why: a client that predates `maxResults` on this call sends none at all, and it cannot
    // reassemble a streamed reply either — it has to be answered on the plain response path.
    const oldClient = await listFiles()
    expect(oldClient).toHaveLength(listablePaths.length)
    expect(new Set(oldClient)).toEqual(new Set(listablePaths))
  } finally {
    cleanupDockerSshRelayTarget(target)
  }
})
