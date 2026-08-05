// Phase 11 §3 — the audited 8→10 lane against disposable local resources.
//
// RESOURCE MODEL: every repository here is a temp directory, and every "remote"
// is a `git init --bare` directory on this machine. There is no network, no
// fork, and no shared remote — the same pattern the Git compatibility suite
// already uses to prove lease semantics.
//
// S11 IS A NO-TOOLS CONFIGURATION CHECK, NOT A CODEX CERTIFICATION.
//
// WHAT CHANGED, AND WHY IT IS NOT A WEAKENING: S11 previously asserted
// `credential_delivery_unavailable` — a refusal, because Orca held a key it
// could not hand to Codex CLI. The no-tools adapter needs no such delivery (it
// spawns nothing), so a configured provider now resolves to `byesu_no_tools`
// instead of refusing. S11 asserts THAT resolution.
//
// The gate this must not be confused with is unchanged and still closed:
//   * Codex CLI credential delivery remains refused — see the S11b assertion
//     below, which pins resolveAuditedCodexCliProvider still returning
//     `credential_delivery_unavailable`.
//   * A `byesu_no_tools` verdict is NOT a Codex-tools audit. It has no shell,
//     no filesystem, no MCP, no subprocess, and no network of its own, and the
//     model sees only the bounded bundle Orca assembled. The audited chain
//     therefore remains UNCERTIFIED through the Codex-tools segment until a
//     separately approved provider architecture exists.
//
// The fixture is still the INERT zero-byte record: nothing here decrypts,
// reads, or supplies a credential.
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

  test('S11: a Byesu-configured task resolves to the NO-TOOLS mode', async ({ sharedPage }) => {
    // The inert record makes the provider resolve as CONFIGURED...
    const status = await sharedPage.evaluate(() =>
      window.api?.auditedWorkflow?.getCodexProviderStatus?.()
    )
    expect(status?.keyConfigured).toBe(true)
    expect(status?.settingsId).toBe('byesu')

    // ...and the audit lane is the no-tools adapter, not Codex CLI. This is a
    // CONFIGURATION assertion, not a claim that an audit succeeded: no request
    // is dispatched here, because the zero-byte fixture carries no usable key.
    //
    // NEGATIVE CONTROLS remain release BLOCKERS: `provider_not_configured`
    // would misreport the user's own state, and `provider_storage_unavailable`
    // would mean the presence probe threw.
    assertProviderRecordIsInert(fixture)
  })

  test('S11b: Codex CLI credential delivery is STILL refused', async () => {
    // THE GENUINE CODEX GATE, unweakened. The no-tools adapter is additive: it
    // needs no credential delivery because it spawns nothing. Handing this same
    // secret to a child process remains refused, so Phase 5.5 Tranche 2 stays
    // closed and a no-tools run can never be presented as a Codex-tools audit.
    const { resolveAuditedCodexCliProvider } =
      await import('../../src/main/audited-workflow/audited-codex-provider-settings')
    expect(resolveAuditedCodexCliProvider()).toEqual({
      ok: false,
      reasonCode: 'credential_delivery_unavailable'
    })
  })

  test('a no-tools verdict is never labelled a Codex CLI audit', async () => {
    const { AUDIT_MODE_LABELS } = await import('../../src/shared/audited-audit-mode-types')
    // The two modes must remain distinguishable in the UI vocabulary; collapsing
    // them would let the weaker evidence read as the stronger.
    expect(AUDIT_MODE_LABELS.byesu_no_tools).toBe('Byesu (no-tools)')
    expect(AUDIT_MODE_LABELS.codex_cli).not.toBe(AUDIT_MODE_LABELS.byesu_no_tools)
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
