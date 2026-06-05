/* eslint-disable max-lines -- Docker SSH E2E owns target lifecycle, repo seeding, and hosted-review assertions in one opt-in scenario. */
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { execFileSync } from 'child_process'
import os from 'os'
import path from 'path'

import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

type DockerSshTarget = {
  containerName: string
  keyDir: string
  keyPath: string
  host: string
  port: number
  username: string
}

type FakeGh = {
  dir: string
  logPath: string
  originalPath: string | undefined
}

type RemoteHostedReviewRepo = {
  targetId: string
  repoPath: string
  worktreePath: string
  branch: string
}

const RUN_DOCKER_SSH = process.env.ORCA_E2E_SSH_DOCKER === '1'
const DEFAULT_DOCKER_IMAGE = 'orca-e2e-ssh-hosted-review:latest'
const REMOTE_REPO_PATH = '/home/tester/demo-project'
const REMOTE_BRANCH = 'feature/ssh-e2e'
const FAKE_OWNER_REPO = 'acme/orca-ssh-e2e'
let fakeGh: FakeGh | null = null

function run(
  command: string,
  args: string[],
  options?: { cwd?: string; timeout?: number }
): string {
  return execFileSync(command, args, {
    cwd: options?.cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: options?.timeout ?? 30_000
  })
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function wait(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function installFakeGh(): FakeGh {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-fake-gh-'))
  const logPath = path.join(dir, 'gh-calls.jsonl')
  const scriptPath = path.join(dir, 'gh.js')
  const script = `#!/usr/bin/env node
const fs = require('fs')
const path = require('path')
const args = process.argv.slice(2)
const logPath = process.env.ORCA_E2E_FAKE_GH_LOG || path.join(__dirname, 'gh-calls.jsonl')
fs.appendFileSync(logPath, JSON.stringify({ args, cwd: process.cwd() }) + '\\n')

function optionValue(name) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : null
}

if (args[0] === 'auth' && args[1] === 'status') {
  process.exit(0)
}
if (args[0] === 'api' && /\\/pulls\\?/.test(args[1] || '')) {
  console.log('[]')
  process.exit(0)
}
if (args[0] === 'pr' && args[1] === 'list') {
  console.log('[]')
  process.exit(0)
}
if (args[0] === 'pr' && args[1] === 'view') {
  console.error('no pull requests found')
  process.exit(1)
}
if (args[0] === 'pr' && args[1] === 'create') {
  const repo = optionValue('--repo') || '${FAKE_OWNER_REPO}'
  console.log(\`https://github.com/\${repo}/pull/91\`)
  process.exit(0)
}

console.error('unsupported fake gh invocation: ' + args.join(' '))
process.exit(1)
`
  writeFileSync(scriptPath, script)
  chmodSync(scriptPath, 0o755)
  writeFileSync(path.join(dir, 'gh'), `#!/usr/bin/env bash\nexec node "${scriptPath}" "$@"\n`)
  chmodSync(path.join(dir, 'gh'), 0o755)
  writeFileSync(path.join(dir, 'gh.cmd'), `@echo off\r\nnode "%~dp0\\gh.js" %*\r\n`)

  const originalPath = process.env.PATH
  process.env.ORCA_E2E_FAKE_GH_LOG = logPath
  process.env.PATH = `${dir}${path.delimiter}${originalPath ?? ''}`
  return { dir, logPath, originalPath }
}

function restoreFakeGh(installed: FakeGh | null): void {
  if (!installed) {
    return
  }
  if (installed.originalPath === undefined) {
    delete process.env.PATH
  } else {
    process.env.PATH = installed.originalPath
  }
  delete process.env.ORCA_E2E_FAKE_GH_LOG
  rmSync(installed.dir, { recursive: true, force: true })
}

function ensureDockerImage(): string {
  const image = process.env.ORCA_E2E_SSH_DOCKER_IMAGE?.trim() || DEFAULT_DOCKER_IMAGE
  if (image !== DEFAULT_DOCKER_IMAGE) {
    try {
      run('docker', ['image', 'inspect', image], { timeout: 10_000 })
      return image
    } catch {
      throw new Error(`Docker image ${image} does not exist.`)
    }
  }
  const fixtureDir = path.join(
    process.cwd(),
    'tests',
    'e2e',
    'fixtures',
    'ssh-hosted-review-target'
  )
  run('docker', ['build', '-t', image, fixtureDir], { timeout: 180_000 })
  return image
}

function parseDockerPort(output: string): number {
  const match = output.trim().match(/:(\d+)$/)
  const port = match ? Number(match[1]) : NaN
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Could not parse Docker SSH port from: ${output}`)
  }
  return port
}

function startDockerSshTarget(): DockerSshTarget {
  const image = ensureDockerImage()
  const keyDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-ssh-key-'))
  const keyPath = path.join(keyDir, 'id_ed25519')
  run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyPath])
  const publicKey = readFileSync(`${keyPath}.pub`, 'utf8').trim()
  const containerName = `orca-e2e-ssh-hosted-review-${process.pid}-${Date.now()}`
  run('docker', [
    'run',
    '-d',
    '--name',
    containerName,
    '-p',
    '127.0.0.1::22',
    '-e',
    `AUTHORIZED_KEY=${publicKey}`,
    image
  ])
  const port = parseDockerPort(run('docker', ['port', containerName, '22/tcp']))
  const target = { containerName, keyDir, keyPath, host: '127.0.0.1', port, username: 'tester' }
  waitForSsh(target)
  return target
}

function sshArgs(target: DockerSshTarget): string[] {
  return [
    '-i',
    target.keyPath,
    '-p',
    String(target.port),
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=no',
    '-o',
    'UserKnownHostsFile=/dev/null',
    '-o',
    'ConnectTimeout=2',
    `${target.username}@${target.host}`
  ]
}

function runSsh(target: DockerSshTarget, script: string): string {
  return run('ssh', [...sshArgs(target), 'bash', '-lc', shellQuote(script)], { timeout: 30_000 })
}

function waitForSsh(target: DockerSshTarget): void {
  let lastError: unknown
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      runSsh(target, 'true')
      return
    } catch (error) {
      lastError = error
      wait(500)
    }
  }
  throw new Error(`SSH target did not become ready: ${String(lastError)}`)
}

function seedRemoteRepo(target: DockerSshTarget): void {
  runSsh(
    target,
    `
set -euo pipefail
rm -rf ${shellQuote(REMOTE_REPO_PATH)}
mkdir -p ${shellQuote(REMOTE_REPO_PATH)}
cd ${shellQuote(REMOTE_REPO_PATH)}
git init -b main
git config user.email e2e@example.test
git config user.name "SSH E2E"
printf 'base\\n' > README.md
git add README.md
git commit -m "Initial commit"
git remote add origin https://github.com/${FAKE_OWNER_REPO}.git
git update-ref refs/remotes/origin/main HEAD
git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main
git checkout -b ${shellQuote(REMOTE_BRANCH)}
printf 'feature\\n' > feature.txt
git add feature.txt
git commit -m "Add SSH hosted review file"
git update-ref refs/remotes/origin/${shellQuote(REMOTE_BRANCH)} HEAD
git branch --set-upstream-to=origin/${shellQuote(REMOTE_BRANCH)} ${shellQuote(REMOTE_BRANCH)}
test -z "$(git status --porcelain)"
`
  )
}

function stopDockerSshTarget(target: DockerSshTarget | null): void {
  if (!target) {
    return
  }
  try {
    run('docker', ['rm', '-f', target.containerName], { timeout: 20_000 })
  } catch {
    // Best-effort Docker cleanup.
  }
  rmSync(target.keyDir, { recursive: true, force: true })
}

function readFakeGhCalls(): { args: string[]; cwd: string }[] {
  if (!fakeGh || !existsSync(fakeGh.logPath)) {
    return []
  }
  if (!readFileSync(fakeGh.logPath, 'utf8').trim()) {
    return []
  }
  return readFileSync(fakeGh.logPath, 'utf8')
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line) as { args: string[]; cwd: string })
}

test.describe('Docker SSH hosted review creation', () => {
  test.skip(
    !RUN_DOCKER_SSH,
    'Set ORCA_E2E_SSH_DOCKER=1 to run the Linux Docker SSH hosted-review E2E test.'
  )
  test.skip(process.platform === 'win32', 'Docker SSH hosted-review E2E uses POSIX ssh commands.')

  test.beforeAll(() => {
    fakeGh = installFakeGh()
  })

  test.afterAll(() => {
    restoreFakeGh(fakeGh)
    fakeGh = null
  })

  test('creates a GitHub pull request from an SSH worktree through the hosted-review IPC path', async ({
    orcaPage
  }) => {
    test.slow()
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)

    let target: DockerSshTarget | null = null
    try {
      target = startDockerSshTarget()
      seedRemoteRepo(target)

      const remote = await orcaPage.evaluate(
        async ({ remotePath, target }) => {
          const store = window.__store
          if (!store) {
            throw new Error('Store unavailable')
          }
          const credentialUnsub = window.api.ssh.onCredentialRequest((request) => {
            void window.api.ssh.submitCredential({ requestId: request.requestId, value: null })
          })
          try {
            const createdTarget = await window.api.ssh.addTarget({
              target: {
                label: `Docker SSH Hosted Review ${Date.now()}`,
                host: target.host,
                port: target.port,
                username: target.username,
                identityFile: target.keyPath,
                // Why: this opt-in test tears down its container immediately;
                // keeping relay daemons around only makes failure cleanup noisy.
                relayGracePeriodSeconds: 1
              }
            })
            const state = await window.api.ssh.connect({ targetId: createdTarget.id })
            if (!state || state.status !== 'connected') {
              throw new Error(`SSH target did not connect: ${JSON.stringify(state)}`)
            }

            store.getState().setSshConnectionState(createdTarget.id, state)
            const labels = new Map(store.getState().sshTargetLabels)
            labels.set(createdTarget.id, createdTarget.label)
            store.getState().setSshTargetLabels(labels)

            const result = await window.api.repos.addRemote({
              connectionId: createdTarget.id,
              remotePath,
              displayName: 'Docker SSH Hosted Review E2E'
            })
            if ('error' in result) {
              throw new Error(result.error)
            }

            await store.getState().fetchRepos()
            await store.getState().fetchWorktrees(result.repo.id)
            const worktrees = store.getState().worktreesByRepo[result.repo.id] ?? []
            const worktree =
              worktrees.find((candidate) => candidate.path === result.repo.path) ?? worktrees[0]
            if (!worktree) {
              throw new Error(`No SSH worktree found for ${result.repo.path}`)
            }
            store.getState().setActiveWorktree(worktree.id)
            return {
              targetId: createdTarget.id,
              repoPath: result.repo.path,
              worktreePath: worktree.path,
              branch: worktree.branch.replace(/^refs\/heads\//, '')
            }
          } finally {
            credentialUnsub()
          }
        },
        { remotePath: REMOTE_REPO_PATH, target }
      )

      expect(remote).toMatchObject<RemoteHostedReviewRepo>({
        targetId: expect.any(String),
        repoPath: REMOTE_REPO_PATH,
        worktreePath: REMOTE_REPO_PATH,
        branch: REMOTE_BRANCH
      })

      const eligibility = await orcaPage.evaluate(
        async ({ remote }) => {
          return window.api.hostedReview.getCreationEligibility({
            repoPath: remote.repoPath,
            worktreePath: remote.worktreePath,
            branch: remote.branch,
            hasUncommittedChanges: false,
            hasUpstream: true,
            ahead: 0,
            behind: 0
          })
        },
        { remote }
      )

      expect(eligibility).toMatchObject({
        provider: 'github',
        canCreate: true,
        blockedReason: null,
        defaultBaseRef: 'origin/main',
        head: REMOTE_BRANCH,
        title: 'Add SSH hosted review file'
      })

      const createResult = await orcaPage.evaluate(
        async ({ remote }) => {
          return window.api.hostedReview.create({
            repoPath: remote.repoPath,
            worktreePath: remote.worktreePath,
            provider: 'github',
            base: 'main',
            head: remote.branch,
            title: 'SSH hosted review from Docker',
            body: 'Created by the Docker SSH hosted-review E2E test.',
            draft: false
          })
        },
        { remote }
      )

      expect(createResult).toEqual({
        ok: true,
        number: 91,
        url: `https://github.com/${FAKE_OWNER_REPO}/pull/91`
      })
      expect(readFakeGhCalls()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ args: expect.arrayContaining(['auth', 'status']) }),
          expect.objectContaining({ args: expect.arrayContaining(['pr', 'create']) })
        ])
      )
      expect(runSsh(target, `cd ${shellQuote(REMOTE_REPO_PATH)} && git status --porcelain`)).toBe(
        ''
      )
    } finally {
      stopDockerSshTarget(target)
    }
  })
})
