// Offline proof: a distinct upstream remote resolves before gh, requiring no network or auth.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import type { Page } from '@stablyai/playwright-test'

import { connectDockerSshRelayTarget } from './helpers/docker-ssh-relay-connection'
import {
  cleanupDockerSshRelayTarget,
  execDockerSshRelayTargetCommand,
  shellQuote,
  startDockerSshRelayTarget,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import { test, expect } from './helpers/orca-app'
import { createRestartSession, readRestartRendererState } from './helpers/orca-restart'

const RUN_DOCKER_SSH = process.env.ORCA_E2E_SSH_DOCKER === '1'

const FORK_REPO_PATH = '/tmp/orca-docker-fork-upstream-repo'
const FORK_ORIGIN_URL = 'https://github.com/orca-e2e-contributor/orca.git'
const UPSTREAM_URL = 'https://github.com/stablyai/orca.git'
const EXPECTED_UPSTREAM = { owner: 'stablyai', repo: 'orca' }
const FORK_BADGE_LABEL = 'Fork of stablyai/orca'

/** A fork clone: `origin` is the personal copy, `upstream` is the parent. */
function seedForkRepoOnTarget(target: DockerSshRelayTarget): void {
  execDockerSshRelayTargetCommand(
    target,
    [
      `rm -rf ${shellQuote(FORK_REPO_PATH)}`,
      `mkdir -p ${shellQuote(FORK_REPO_PATH)}`,
      `cd ${shellQuote(FORK_REPO_PATH)}`,
      'git init',
      'git config user.email e2e@test.local',
      'git config user.name "Orca Fork Upstream E2E"',
      `git remote add origin ${shellQuote(FORK_ORIGIN_URL)}`,
      `git remote add upstream ${shellQuote(UPSTREAM_URL)}`,
      "printf '%s\\n' 'fork upstream backfill fixture' > README.md",
      'git add README.md',
      'git commit -m initial'
    ].join(' && ')
  )
}

type PersistedUpstream = { owner: string; repo: string; host?: string } | null | 'absent'

/**
 * Why `readRestartRendererState`: a relaunched window replaces its document
 * during initial hydration, which destroys the execution context mid-evaluate.
 * The wrapper turns that transition into `null` so the enclosing poll retries.
 */
async function readRepoUpstream(
  page: Page,
  repoId: string
): Promise<PersistedUpstream | 'gone' | null> {
  return readRestartRendererState(() =>
    page.evaluate(async (repoId) => {
      const store = window.__store
      if (!store) {
        throw new Error('Store unavailable')
      }
      await store.getState().fetchRepos()
      const repo = store.getState().repos.find((candidate) => candidate.id === repoId)
      if (!repo) {
        return 'gone' as const
      }
      // Why: `undefined` (never probed) and `null` (probed, not a fork) are
      // different states and both survive this boundary badly — name them.
      return repo.upstream === undefined ? ('absent' as const) : repo.upstream
    }, repoId)
  )
}

/**
 * Every file the live store could be writing.
 *
 * Why not just `<userData>/orca-data.json`: the Store is constructed with the
 * *active profile's* data file (`index.ts` → `new Store({ dataFile })`), which
 * lives under `profiles/<id>/`. The launch dir only holds the seeded profile.
 */
function candidateStoreFiles(userDataPath: string): string[] {
  const profilesDir = path.join(userDataPath, 'profiles')
  let profileFiles: string[] = []
  try {
    profileFiles = readdirSync(profilesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(profilesDir, entry.name, 'orca-data.json'))
  } catch {
    // No profiles directory yet.
  }
  return [...profileFiles, path.join(userDataPath, 'orca-data.json')]
}

function findStoreFileWithRepo(userDataPath: string, repoId: string): string | null {
  for (const storePath of candidateStoreFiles(userDataPath)) {
    try {
      const data = JSON.parse(readFileSync(storePath, 'utf8')) as { repos?: { id: string }[] }
      if ((data.repos ?? []).some((repo) => repo.id === repoId)) {
        return storePath
      }
    } catch {
      // Why: the store rewrites via a temp file, so a read can land mid-swap.
    }
  }
  return null
}

/** Why: saves are debounced ~1s, so closing right after `addRemote` can beat the write. */
async function waitForPersistedRepo(userDataPath: string, repoId: string): Promise<string> {
  await expect
    .poll(() => findStoreFileWithRepo(userDataPath, repoId) !== null, {
      timeout: 30_000,
      message:
        `repo ${repoId} never reached any store file under ${userDataPath}. ` +
        `Checked: ${candidateStoreFiles(userDataPath).join(' | ')}`
    })
    .toBe(true)
  const storePath = findStoreFileWithRepo(userDataPath, repoId)
  if (!storePath) {
    throw new Error(`Store file for ${repoId} disappeared after polling`)
  }
  return storePath
}

/**
 * Rewrite the persisted repo to the pre-fork-detection shape.
 *
 * Why not `repos.update`: `sanitizeRepoUpdatesForPersistence` treats an
 * `undefined` upstream as "no change" and drops it, so the field cannot be
 * cleared through the app. Legacy state only exists on disk.
 */
function stripPersistedUpstream(storePath: string, repoId: string): void {
  const data = JSON.parse(readFileSync(storePath, 'utf8')) as {
    repos?: { id: string; upstream?: unknown }[]
  }
  const repo = data.repos?.find((candidate) => candidate.id === repoId)
  if (!repo) {
    throw new Error(`Repo ${repoId} not found in ${storePath}`)
  }
  if (!('upstream' in repo)) {
    throw new Error(`Repo ${repoId} had no persisted upstream to strip — fixture assumption broke`)
  }
  delete repo.upstream
  writeFileSync(storePath, `${JSON.stringify(data, null, 2)}\n`)
}

test.describe('Docker SSH fork upstream backfill', () => {
  test.skip(!RUN_DOCKER_SSH, 'Set ORCA_E2E_SSH_DOCKER=1 to run Docker-backed SSH tests.')
  test.skip(process.platform === 'win32', 'Docker SSH fixtures use POSIX tooling.')

  test('backfills a legacy SSH fork and renders its badge once the connection comes up', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
  {}, testInfo) => {
    test.slow()
    let target: DockerSshRelayTarget | null = null
    const session = createRestartSession(testInfo)

    try {
      target = startDockerSshRelayTarget(testInfo)
      seedForkRepoOnTarget(target)

      // ── Launch 1: add the remote fork the normal way ──────────────────
      const first = await session.launch()
      const remote = await connectDockerSshRelayTarget(first.page, target, {
        remotePath: FORK_REPO_PATH
      })
      // Add-time detection already handles SSH, so this proves the probe itself
      // works over the relay — isolating the bug to the startup backfill.
      await expect
        .poll(() => readRepoUpstream(first.page, remote.repoId), {
          timeout: 60_000,
          message: 'add-time detection never resolved the fork upstream over SSH'
        })
        .toMatchObject(EXPECTED_UPSTREAM)
      // Why: ask the app where it actually persists rather than assuming the
      // launch dir — profile redirection would silently strip nothing.
      const userDataPath = await first.app.evaluate(({ app }) => app.getPath('userData'))
      const storePath = await waitForPersistedRepo(userDataPath, remote.repoId)
      await session.close(first.app)

      stripPersistedUpstream(storePath, remote.repoId)

      // ── Launch 2: the repo now looks like it predates fork detection ──
      const second = await session.launch()
      // Why poll: this doubles as the hydration barrier — the relaunched window
      // swaps its document once before the store is readable.
      await expect
        .poll(() => readRepoUpstream(second.page, remote.repoId), {
          timeout: 30_000,
          message: 'relaunched app never surfaced the stripped repo as unresolved'
        })
        .toBe('absent')
      await expect(second.page.getByLabel(FORK_BADGE_LABEL)).toHaveCount(0)

      const connected = await second.page.evaluate(async (targetId) => {
        const store = window.__store
        if (!store) {
          throw new Error('Store unavailable')
        }
        const state = await window.api.ssh.connect({ targetId })
        if (!state || state.status !== 'connected') {
          throw new Error(`SSH target did not connect: ${JSON.stringify(state)}`)
        }
        store.getState().setSshConnectionState(targetId, state)
        return state.status
      }, remote.targetId)
      expect(connected).toBe('connected')

      // ── The fix: connect alone backfills, with no settings visit ──────
      await expect
        .poll(() => readRepoUpstream(second.page, remote.repoId), {
          timeout: 90_000,
          message: 'connecting the SSH target did not backfill the fork upstream'
        })
        .toMatchObject(EXPECTED_UPSTREAM)
      await expect(second.page.getByLabel(FORK_BADGE_LABEL).first()).toBeVisible({
        timeout: 30_000
      })

      testInfo.annotations.push({
        type: 'ssh-fork-upstream-backfill',
        description: `target=${remote.targetId} repo=${remote.repoId} upstream=stablyai/orca`
      })
      await session.close(second.app)
    } finally {
      await session.dispose()
      cleanupDockerSshRelayTarget(target)
    }
  })
})
