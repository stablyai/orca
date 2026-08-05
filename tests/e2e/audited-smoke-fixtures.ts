// Shared fixture harness for the Phase 11 release-readiness runs.
//
// Both the installer smoke and the audited 8-10 E2E use THIS module, so the two
// fixtures cannot drift apart — a divergence between them would mean the gate
// that blocks a release and the gate that proves migration were testing
// different worlds.
//
// TWO FIXTURES, ONE DISPOSABLE ROOT:
//
//   <root>/ud/audited-workflow.db              copied v9 database (§1a)
//   <root>/ud/home/.orca/…provider-token.enc   zero-byte provider record (§3a)
//
// SECRET BOUNDARY. Nothing here writes, reads, decrypts, masks, or logs a
// credential. The provider record is written as ZERO BYTES by this harness —
// never by saveAuditedCodexProviderKey, which would encrypt a value. No provider
// API key is passed by environment or argv. The v9 database carries synthetic
// task metadata only.
//
// ISOLATION IS A PRODUCTION SEAM, NOT A TEST HOOK. configureDevUserDataPath
// reads ORCA_E2E_USER_DATA_DIR / ORCA_E2E_HOME_DIR and THROWS
// "Refusing to start E2E outside its disposable home boundary" when homedir()
// does not already match. That guard is why this is safe to run on a developer
// machine: a misconfigured launch aborts rather than writing into the real
// ~/.orca profile.
import { copyFileSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The provider-key filename the key store derives from homedir()/.orca. */
export const PROVIDER_KEY_FILENAME = 'audited-workflow-codex-provider-token.enc'

/** Where the audited repository resolves its database, relative to userData. */
export const AUDITED_DB_FILENAME = 'audited-workflow.db'

export const V9_FIXTURE_PATH = join(
  __dirname,
  '..',
  'fixtures',
  'audited-workflow',
  'v9',
  AUDITED_DB_FILENAME
)

export type AuditedSmokeFixture = {
  /** The one disposable root; deleting it removes BOTH fixtures. */
  root: string
  userDataDir: string
  homeDir: string
  /** The seeded v9 database the app will migrate in place. */
  databasePath: string
  /** The zero-byte provider record, or null when S11 is not in play. */
  providerKeyPath: string | null
  /** Env the packaged/dev app must launch with. Contains NO credential. */
  env: Record<string, string>
}

export type CreateFixtureOptions = {
  /**
   * Whether to plant the inert Byesu provider record (§3a / S11).
   *
   * Default false: only the scenario that asserts
   * `credential_delivery_unavailable` needs a configured provider, and every
   * other run should see the honest "no provider" state.
   */
  withInertProviderRecord?: boolean
  /**
   * Whether to seed the v9 database (§1a).
   *
   * Default true for the installer smoke. A run that wants a first-launch
   * profile passes false — but note that such a run proves NOTHING about
   * migration, which is why the release gate requires the seeded path.
   */
  withV9Database?: boolean
}

/**
 * Creates the disposable root and plants the requested fixtures.
 *
 * Call BEFORE launching the app: the audited repository resolves
 * join(app.getPath('userData'), 'audited-workflow.db') on first use, so a
 * database planted after launch would be ignored.
 */
export function createAuditedSmokeFixture(options: CreateFixtureOptions = {}): AuditedSmokeFixture {
  const root = mkdtempSync(join(tmpdir(), 'orca-smoke-'))
  const userDataDir = join(root, 'ud')
  const homeDir = join(userDataDir, 'home')
  mkdirSync(homeDir, { recursive: true })

  const databasePath = join(userDataDir, AUDITED_DB_FILENAME)
  if (options.withV9Database !== false) {
    // COPIED, never opened in place: a run must not be able to mutate the
    // committed fixture. The provenance test asserts this holds.
    copyFileSync(V9_FIXTURE_PATH, databasePath)
  }

  let providerKeyPath: string | null = null
  if (options.withInertProviderRecord) {
    const orcaDir = join(homeDir, '.orca')
    mkdirSync(orcaDir, { recursive: true })
    providerKeyPath = join(orcaDir, PROVIDER_KEY_FILENAME)
    // ZERO BYTES. Presence detection is an existsSync on an opaque file, so this
    // reaches the credential_delivery_unavailable branch without any key
    // existing. See audited-codex-provider-inert-fixture.test.ts, which pins
    // that invariant and fails first if it ever changes.
    writeFileSync(providerKeyPath, Buffer.alloc(0), { mode: 0o600 })
  }

  return {
    root,
    userDataDir,
    homeDir,
    databasePath,
    providerKeyPath,
    env: {
      ORCA_E2E_USER_DATA_DIR: userDataDir,
      ORCA_E2E_HOME_DIR: homeDir,
      // Both must be aligned or the disposable-home guard aborts startup.
      HOME: homeDir,
      USERPROFILE: homeDir
    }
  }
}

/** Removes the disposable root, and with it BOTH fixtures. Never throws. */
export function cleanupAuditedSmokeFixture(fixture: AuditedSmokeFixture): void {
  try {
    rmSync(fixture.root, { recursive: true, force: true })
  } catch {
    // A leaked temp dir is inert and must never fail a release gate.
  }
}

/**
 * Asserts the planted provider record is genuinely inert.
 *
 * Used by S11 so the scenario proves the fixture carried no secret material,
 * rather than only that the app refused.
 */
export function assertProviderRecordIsInert(fixture: AuditedSmokeFixture): void {
  if (!fixture.providerKeyPath) {
    throw new Error('No provider record was planted for this fixture')
  }
  const size = statSync(fixture.providerKeyPath).size
  if (size !== 0) {
    throw new Error(`Provider record must be zero bytes, found ${size}`)
  }
  if (!fixture.providerKeyPath.startsWith(fixture.root)) {
    throw new Error('Provider record escaped the disposable root')
  }
}

/**
 * The env-var names that must NEVER appear in a Phase 11 job or launch.
 *
 * Asserted by the specs and mirrored by the workflows' no-secrets step, so the
 * boundary is enforced in both places rather than trusted to review.
 */
export const FORBIDDEN_CREDENTIAL_ENV_KEYS = [
  'ORCA_AUDITED_CODEX_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GH_TOKEN',
  'GITHUB_TOKEN'
] as const

/** Throws when any credential env var is set in the given environment. */
export function assertNoCredentialEnv(env: NodeJS.ProcessEnv = process.env): void {
  const present = FORBIDDEN_CREDENTIAL_ENV_KEYS.filter((key) => Boolean(env[key]))
  if (present.length > 0) {
    throw new Error(
      `Phase 11 runs must be secret-free, but these are set: ${present.join(', ')}. ` +
        'The Codex lane is asserted-blocked, which needs no key.'
    )
  }
}
