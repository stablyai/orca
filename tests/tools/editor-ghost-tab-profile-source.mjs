/**
 * Loads a persisted Orca profile for the ghost-tab repro from either storage generation: the
 * legacy `orca-data.json` or the SQLite `profile-state.db` that replaced it. Once a profile is
 * migrated the JSON is only refreshed at clean shutdown, so while the app runs it is stale and the
 * database is the truth. The source is only ever read — the database is copied before opening.
 *
 * Mirrors main's classifyProfileStateStorage / readProfileStateParsedSnapshot, which this branch
 * predates, so the read goes through node:sqlite directly.
 */

import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const PROFILE_DATA_FILE = 'orca-data.json'
export const PROFILE_DATABASE_FILE = 'profile-state.db'

/** Primary first; `-shm` is only an index and is rebuilt from the copied WAL. */
const DATABASE_FAMILY_SUFFIXES = ['', '-wal', '-shm', '-journal']
const DATABASE_SNAPSHOT_SUFFIXES = ['', '-wal', '-journal']

/**
 * Where a `--data` argument points. A directory is a profile dir; an `orca-data.json` still has a
 * sibling database to check; any other JSON file is an export and stands alone.
 */
export function resolveProfileStateFiles(dataArg) {
  if (existsSync(dataArg) && statSync(dataArg).isDirectory()) {
    return {
      dataFile: path.join(dataArg, PROFILE_DATA_FILE),
      databaseFile: path.join(dataArg, PROFILE_DATABASE_FILE)
    }
  }
  return {
    dataFile: dataArg,
    databaseFile:
      path.basename(dataArg) === PROFILE_DATA_FILE
        ? path.join(path.dirname(dataArg), PROFILE_DATABASE_FILE)
        : null
  }
}

/** Any surviving database-family file counts, as in main: a stray WAL still means "migrated". */
export function classifyProfileStateStorage(dataFile, databaseFile) {
  const hasJson = existsSync(dataFile)
  const hasDatabase =
    databaseFile !== null &&
    DATABASE_FAMILY_SUFFIXES.some((suffix) => existsSync(`${databaseFile}${suffix}`))
  if (hasJson && hasDatabase) {
    return 'both'
  }
  if (hasJson) {
    return 'json-only'
  }
  return hasDatabase ? 'sqlite-only' : 'neither'
}

function loadNodeSqlite() {
  const sqlite =
    typeof process.getBuiltinModule === 'function' ? process.getBuiltinModule('node:sqlite') : null
  if (!sqlite?.DatabaseSync) {
    throw new Error(
      'node:sqlite is unavailable in this Node.js runtime; use Node 22.13+ or pass an exported JSON'
    )
  }
  return sqlite.DatabaseSync
}

/** Every domain, not just the session: the isolated app needs the catalog to route the heal. */
export function readProfileStateDatabase(databaseFile) {
  if (!existsSync(databaseFile)) {
    throw new Error(`${databaseFile} is missing but its journal files exist; cannot read it`)
  }
  const DatabaseSync = loadNodeSqlite()
  // Why a copy: opening a WAL database, even read-only, touches its -shm next to the live app.
  const snapshotDir = mkdtempSync(path.join(os.tmpdir(), 'orca-profile-state-read-'))
  try {
    const snapshotFile = path.join(snapshotDir, PROFILE_DATABASE_FILE)
    for (const suffix of DATABASE_SNAPSHOT_SUFFIXES) {
      if (existsSync(`${databaseFile}${suffix}`)) {
        copyFileSync(`${databaseFile}${suffix}`, `${snapshotFile}${suffix}`)
      }
    }
    const db = new DatabaseSync(snapshotFile)
    try {
      const rows = db.prepare('SELECT domain, payload FROM profile_state_documents').all()
      return Object.fromEntries(rows.map((row) => [row.domain, JSON.parse(row.payload)]))
    } finally {
      db.close()
    }
  } finally {
    rmSync(snapshotDir, { recursive: true, force: true })
  }
}

/** The parsed profile plus where it came from; `warnings` are for the caller to print. */
export function loadProfileState(dataArg) {
  const { dataFile, databaseFile } = resolveProfileStateFiles(dataArg)
  const classification = classifyProfileStateStorage(dataFile, databaseFile)
  if (classification === 'neither') {
    const looked = databaseFile ? `${dataFile} and ${databaseFile}` : dataFile
    throw new Error(`No profile state at ${dataArg}: looked for ${looked}`)
  }
  if (classification === 'json-only') {
    return {
      state: JSON.parse(readFileSync(dataFile, 'utf8')),
      classification,
      sourceFile: dataFile,
      warnings: []
    }
  }
  return {
    state: readProfileStateDatabase(databaseFile),
    classification,
    sourceFile: databaseFile,
    warnings:
      classification === 'both'
        ? [
            `${dataFile} and ${databaseFile} both exist; reading the database, since the JSON` +
              ' is only refreshed at clean shutdown and may be stale'
          ]
        : []
  }
}
