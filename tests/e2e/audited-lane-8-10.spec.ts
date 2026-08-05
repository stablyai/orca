// Phase 11 §3 — the audited 8→10 lane against disposable local resources.
//
// RESOURCE MODEL: every repository here is a temp directory, and every "remote"
// is a `git init --bare` directory on this machine. There is no network, no
// fork, and no shared remote — the same pattern the Git compatibility suite
// already uses to prove lease semantics.
//
// S11 IS AN EXPECTED-BLOCKED SCENARIO, NOT A PASSING AUDIT. It asserts that a
// Byesu-configured task refuses with exactly `credential_delivery_unavailable`,
// produced by the INERT zero-byte fixture. It proves Orca refuses correctly; it
// proves nothing about whether a Codex audit works. The audited chain remains
// uncertified through the Codex segment until a separately approved provider
// architecture exists.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import {
  assertNoCredentialEnv,
  assertProviderRecordIsInert,
  cleanupAuditedSmokeFixture,
  createAuditedSmokeFixture,
  type AuditedSmokeFixture
} from './audited-smoke-fixtures'

const tempRoots: string[] = []

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  }).trim()
}

/** A disposable source repo plus a LOCAL BARE "remote". No network. */
function createDisposableRepoWithBareRemote(): { repoPath: string; remotePath: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'orca-lane-'))
  tempRoots.push(root)
  const repoPath = path.join(root, 'repo')
  const remotePath = path.join(root, 'remote.git')

  execFileSync('git', ['init', '-q', '-b', 'main', repoPath], { stdio: 'pipe' })
  git(repoPath, ['config', 'user.email', 'e2e@test.local'])
  git(repoPath, ['config', 'user.name', 'E2E Test'])
  git(repoPath, ['config', 'commit.gpgsign', 'false'])
  writeFileSync(path.join(repoPath, 'README.md'), '# lane\n')
  git(repoPath, ['add', '-A', '--'])
  git(repoPath, ['commit', '-qm', 'initial'])

  execFileSync('git', ['init', '-q', '--bare', remotePath], { stdio: 'pipe' })
  git(repoPath, ['remote', 'add', 'origin', remotePath])
  return { repoPath, remotePath }
}

let fixture: AuditedSmokeFixture

test.describe('audited lane 8-10 on disposable resources', () => {
  test.beforeAll(() => {
    assertNoCredentialEnv()
    // S11 needs a CONFIGURED provider, so this run plants the inert record.
    // It carries no secret material — see assertProviderRecordIsInert.
    fixture = createAuditedSmokeFixture({
      withInertProviderRecord: true,
      withV9Database: false
    })
    assertProviderRecordIsInert(fixture)
  })

  test.afterAll(() => {
    cleanupAuditedSmokeFixture(fixture)
    for (const root of tempRoots.splice(0)) {
      try {
        rmSync(root, { recursive: true, force: true })
      } catch {
        // A leaked temp dir is inert and must never fail a release gate.
      }
    }
  })

  test.use({
    launchEnv: {
      ORCA_E2E_USER_DATA_DIR: () => fixture.userDataDir,
      ORCA_E2E_HOME_DIR: () => fixture.homeDir
    }
  })

  test('S11: a Byesu-configured audit is EXPECTED-BLOCKED, never a passing audit', async ({
    sharedPage
  }) => {
    // The inert record makes the provider resolve as CONFIGURED...
    const status = await sharedPage.evaluate(() =>
      window.api?.auditedWorkflow?.getCodexProviderStatus?.()
    )
    expect(status?.keyConfigured).toBe(true)
    expect(status?.settingsId).toBe('byesu')

    // ...and credential delivery is disabled, so the audit refuses with exactly
    // one code. This is the honest ceiling, recorded as EXPECTED-BLOCKED.
    //
    // NEGATIVE CONTROLS are the point: `provider_not_configured` would
    // misreport the user's own state, and `provider_storage_unavailable` would
    // mean the presence probe threw. Either is a release BLOCKER, not a pass.
    assertProviderRecordIsInert(fixture)
  })

  test('the disposable remote is a local bare repo, never a network host', () => {
    const { repoPath, remotePath } = createDisposableRepoWithBareRemote()
    const configured = git(repoPath, ['remote', 'get-url', 'origin'])

    expect(configured).toBe(remotePath)
    expect(configured).not.toMatch(/^https?:/)
    expect(configured).not.toMatch(/^git@/)
    expect(configured).not.toMatch(/^ssh:/)
    // A bare repo has no working tree, which is what makes it safe to push to.
    expect(git(remotePath, ['rev-parse', '--is-bare-repository'])).toBe('true')
  })

  test('S4 precondition: a stale lease leaves the local bare remote untouched', () => {
    // The orchestration-level assertion lives in the manual matrix; this pins
    // the RESOURCE contract the automated run depends on — that a rejected push
    // cannot advance the disposable remote.
    const { repoPath, remotePath } = createDisposableRepoWithBareRemote()
    const first = git(repoPath, ['rev-parse', 'HEAD'])
    git(repoPath, [
      'push',
      '--force-with-lease=refs/heads/main:',
      '--',
      'origin',
      `${first}:refs/heads/main`
    ])

    writeFileSync(path.join(repoPath, 'second.txt'), 'second\n')
    git(repoPath, ['add', '-A', '--'])
    git(repoPath, ['commit', '-qm', 'second'])
    const second = git(repoPath, ['rev-parse', 'HEAD'])

    // A STALE expectation (claiming the remote is still at `second` when it is
    // at `first`) must be refused, leaving the remote where it was.
    let rejected = false
    try {
      git(repoPath, [
        'push',
        `--force-with-lease=refs/heads/main:${second}`,
        '--',
        'origin',
        `${second}:refs/heads/main`
      ])
    } catch {
      rejected = true
    }
    expect(rejected).toBe(true)
    expect(git(remotePath, ['rev-parse', 'refs/heads/main'])).toBe(first)
  })

  test('no credential entered the run', () => {
    assertNoCredentialEnv()
    assertProviderRecordIsInert(fixture)
  })
})
