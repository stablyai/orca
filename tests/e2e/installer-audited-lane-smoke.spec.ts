// Phase 11 §1 + §1a — packaged/built-app audited-lane smoke.
//
// THE PACKAGING RISKS THIS COVERS, which unit tests cannot: the app boots from
// its built output, the audited SQLite schema MIGRATES an existing v9 profile to
// v10 with its data intact, and the landing IPC channels are registered.
//
// WHY A SEEDED v9 DATABASE. createAuditedWorkflowTables builds every table at
// current shape, so a first-launch profile is born at v10 and the migration is a
// no-op — asserting `user_version = 10` on a fresh profile would pass even if
// migrateToV10 were deleted. Real users upgrade OVER an existing profile, and
// only the seeded path proves that works.
//
// SECRET-FREE BY CONSTRUCTION. This spec plants no credential, sets no provider
// API key, and asserts none is present in the environment.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import {
  assertNoCredentialEnv,
  cleanupAuditedSmokeFixture,
  createAuditedSmokeFixture,
  V9_FIXTURE_PATH,
  type AuditedSmokeFixture
} from './audited-smoke-fixtures'

/**
 * Reads the audited database with the Node SQLite CLI shim.
 *
 * Uses a child process rather than importing node:sqlite here so the assertions
 * observe the file exactly as it sits on disk after the app closed it.
 */
function querySqlite(databasePath: string, sql: string): string {
  return execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { DatabaseSync } from 'node:sqlite'
       const db = new DatabaseSync(${JSON.stringify(databasePath)}, { readOnly: true })
       try {
         console.log(JSON.stringify(db.prepare(${JSON.stringify(sql)}).all()))
       } finally {
         db.close()
       }`
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
  ).trim()
}

function queryRows(databasePath: string, sql: string): Record<string, unknown>[] {
  return JSON.parse(querySqlite(databasePath, sql)) as Record<string, unknown>[]
}

function userVersion(databasePath: string): number {
  return Number(queryRows(databasePath, 'PRAGMA user_version')[0].user_version)
}

let fixture: AuditedSmokeFixture

test.describe('installer audited-lane smoke', () => {
  test.beforeAll(() => {
    assertNoCredentialEnv()
    expect(existsSync(V9_FIXTURE_PATH), 'committed v9 fixture must exist').toBe(true)
    fixture = createAuditedSmokeFixture({ withV9Database: true })
    // The fixture must be v9 BEFORE launch, or the migration assertion is
    // meaningless — this is the pre-condition half of the both-directions check.
    expect(userVersion(fixture.databasePath)).toBe(9)
  })

  test.afterAll(() => {
    cleanupAuditedSmokeFixture(fixture)
  })

  // The app under test launches with the fixture's isolated profile. Both env
  // vars are required: configureDevUserDataPath throws "Refusing to start E2E
  // outside its disposable home boundary" unless homedir() already matches.
  test.use({
    launchEnv: {
      ORCA_E2E_USER_DATA_DIR: () => fixture.userDataDir,
      ORCA_E2E_HOME_DIR: () => fixture.homeDir
    }
  })

  test('boots and exposes the audited landing surface', async ({ sharedPage }) => {
    await expect(sharedPage.locator('body')).toBeVisible()

    // Channel REGISTRATION only — never invoked. A packaged build that failed to
    // register the landing lane would leave a task permanently unlandable.
    const registered = await sharedPage.evaluate(() => ({
      land: typeof window.api?.auditedWorkflow?.land === 'function',
      recheckLand: typeof window.api?.auditedWorkflow?.recheckLand === 'function'
    }))
    expect(registered.land).toBe(true)
    expect(registered.recheckLand).toBe(true)
  })

  test('migrates the seeded v9 profile to v10 with every row intact', async ({ sharedPage }) => {
    // Force the audited repository to initialize, which is what runs the
    // migration. Listing tasks is read-only and mutates nothing.
    await sharedPage.evaluate(() => window.api?.auditedWorkflow?.listTasks?.({}))

    // At or beyond 10, not exactly 10: what this proves is that the seeded v9
    // profile MIGRATED, and a later phase raising the schema version must not
    // fail the installer gate. The table and column assertions below are what
    // pin the Phase 10 shape specifically.
    expect(userVersion(fixture.databasePath)).toBeGreaterThanOrEqual(10)

    const tables = queryRows(
      fixture.databasePath,
      `SELECT name FROM sqlite_master WHERE type = 'table'`
    ).map((row) => String(row.name))
    expect(tables).toContain('audited_land_attempts')

    const landColumns = queryRows(
      fixture.databasePath,
      'PRAGMA table_info(audited_land_attempts)'
    ).map((row) => String(row.name))
    expect(landColumns).toEqual(
      expect.arrayContaining([
        'commit_attempt_id',
        'publish_attempt_id',
        'intended_sha',
        'intended_base_sha',
        'source_repo_path',
        'source_repo_common_dir',
        'landed_sha',
        'landing_advisory'
      ])
    )

    // The CAS primitive, not merely the table.
    const index = queryRows(
      fixture.databasePath,
      `SELECT sql FROM sqlite_master WHERE type = 'index'
         AND name = 'idx_audited_land_attempts_live'`
    )
    expect(String(index[0]?.sql ?? '')).toContain(`status = 'authorized'`)

    const taskColumns = queryRows(fixture.databasePath, 'PRAGMA table_info(audited_tasks)').map(
      (row) => String(row.name)
    )
    expect(taskColumns).toContain('land_attempt_status')
    expect(taskColumns).toContain('landing_advisory')
    // Pre-existing since Phase 1: the migration must not recreate them.
    expect(taskColumns).toEqual(
      expect.arrayContaining(['landed_sha', 'landed_base_sha', 'landing_reason_code'])
    )

    // DATA PRESERVATION — the actual point of the seeded fixture.
    const tasks = queryRows(
      fixture.databasePath,
      'SELECT id, state, committed_sha, landed_sha FROM audited_tasks ORDER BY id'
    )
    expect(tasks).toHaveLength(3)

    const landed = tasks.find((row) => row.id === 'task_v9_landed')
    expect(landed?.state).toBe('landed')
    // A pre-Phase-10 `landed` row legitimately has no landed_sha.
    expect(landed?.landed_sha).toBeNull()

    const committed = tasks.find((row) => row.id === 'task_v9_committed')
    expect(committed?.committed_sha).toBe('c'.repeat(40))

    const commitAttempts = queryRows(
      fixture.databasePath,
      'SELECT status, created_commit_sha FROM audited_commit_attempts'
    )
    expect(commitAttempts[0]?.status).toBe('completed')

    const publishAttempts = queryRows(
      fixture.databasePath,
      'SELECT status, pushed_sha FROM audited_publish_attempts'
    )
    expect(publishAttempts[0]?.status).toBe('completed')

    // Phase 8's store accounting is untouched by a Phase 10 migration.
    const candidates = queryRows(fixture.databasePath, 'SELECT store_bytes FROM audited_candidates')
    expect(Number(candidates[0]?.store_bytes)).toBe(4096)

    const transitions = queryRows(
      fixture.databasePath,
      'SELECT COUNT(*) n FROM audited_transitions'
    )
    expect(Number(transitions[0]?.n)).toBe(5)
  })

  test('leaves the committed fixture unmodified', () => {
    // Proves the copy-not-open-in-place contract: the harness copied the v9
    // file, so the repository's fixture is still v9 after a full migration run.
    expect(userVersion(V9_FIXTURE_PATH)).toBe(9)
    const tables = queryRows(
      V9_FIXTURE_PATH,
      `SELECT name FROM sqlite_master WHERE type = 'table'`
    ).map((row) => String(row.name))
    expect(tables).not.toContain('audited_land_attempts')
  })

  test('planted no credential anywhere in the disposable profile', () => {
    assertNoCredentialEnv()
    // This spec does not exercise S11, so no provider record should exist.
    expect(fixture.providerKeyPath).toBeNull()
    expect(existsSync(path.join(fixture.homeDir, '.orca'))).toBe(false)
  })
})
