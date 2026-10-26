import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../constants'
import {
  PERSISTED_STATE_DISPOSITIONS,
  WORKSPACE_SESSION_DISPOSITIONS,
  type WslMoveFieldDisposition
} from './wsl-move-dispositions'
import { OUT_OF_STORE_DISPOSITIONS } from './wsl-move-out-of-store-dispositions'
import {
  LOCAL_STORAGE_MODULE_DISPOSITIONS,
  SQLITE_SCHEMA_FILE_DATABASES,
  SQLITE_TABLE_DISPOSITIONS
} from './wsl-move-storage-dispositions'
import { SETTINGS_KEYS_NAMING_A_PATH, UI_STATE_DISPOSITIONS } from './wsl-move-ui-dispositions'

const REPO_ROOT = join(__dirname, '../../..')

function sourceFiles(dir: string): string[] {
  return readdirSync(join(REPO_ROOT, dir), {
    recursive: true,
    withFileTypes: true
  })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
    .map((entry) => relative(REPO_ROOT, join(entry.parentPath, entry.name)).replaceAll('\\', '/'))
    .filter((path) => !/\.(test|spec)\.tsx?$/.test(path))
}

const ALL_ROWS: WslMoveFieldDisposition[] = [
  ...Object.values(PERSISTED_STATE_DISPOSITIONS),
  ...Object.values(WORKSPACE_SESSION_DISPOSITIONS),
  ...Object.values(UI_STATE_DISPOSITIONS),
  ...Object.values(LOCAL_STORAGE_MODULE_DISPOSITIONS),
  ...Object.values(SQLITE_TABLE_DISPOSITIONS),
  ...OUT_OF_STORE_DISPOSITIONS
]

describe('WSL mover dispositions', () => {
  it('decides every inventory item of the design', () => {
    const covered = new Set(ALL_ROWS.map((row) => row.item))
    const missing = Array.from({ length: 62 }, (_, index) => index + 1).filter(
      (item) => !covered.has(item)
    )
    expect(missing).toEqual([])
  })

  it('lists every renderer module that uses localStorage', () => {
    const users = [...sourceFiles('src/renderer/src'), ...sourceFiles('src/shared')]
      // These tables name localStorage; they do not use it.
      .filter((path) => !path.startsWith('src/shared/wsl-move/'))
      .filter((path) => /\blocalStorage\b/.test(readFileSync(join(REPO_ROOT, path), 'utf8')))
      .sort()
    expect(users).toEqual(Object.keys(LOCAL_STORAGE_MODULE_DISPOSITIONS).sort())
  })

  it('lists every SQLite table the app creates, by database', () => {
    const files = sourceFiles('src/main').filter((path) =>
      /CREATE\s+(?:VIRTUAL\s+)?TABLE/.test(readFileSync(join(REPO_ROOT, path), 'utf8'))
    )
    expect(files.sort()).toEqual(Object.keys(SQLITE_SCHEMA_FILE_DATABASES).sort())
    const tables = new Set<string>()
    // An interpolated name is listed as its constant, e.g. `${RUNS_TABLE}`.
    const pattern =
      /CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:\$\{(?:quotedIdentifier\()?([A-Z_]+)|["`']?([a-z0-9_]+))/g
    for (const path of files) {
      const database = SQLITE_SCHEMA_FILE_DATABASES[path]
      for (const match of readFileSync(join(REPO_ROOT, path), 'utf8').matchAll(pattern)) {
        tables.add(`${database}.${match[1] ? `\${${match[1]}}` : match[2]}`)
      }
    }
    expect([...tables].sort()).toEqual(Object.keys(SQLITE_TABLE_DISPOSITIONS).sort())
  })

  it('decides every setting whose name says it holds a path', () => {
    const pathLike = Object.keys(getDefaultSettings('/home/user'))
      .concat(Object.keys(SETTINGS_KEYS_NAMING_A_PATH))
      .filter((key) => /(Cwds?|Paths?|Dir|Dirs|Home)$/.test(key))
    expect([...new Set(pathLike)].sort()).toEqual(Object.keys(SETTINGS_KEYS_NAMING_A_PATH).sort())
  })
})

// Containers whose fields are decided one by one; any other item gets one verdict.
const PER_FIELD_ITEMS = new Set([19, 32, 38])

describe('WSL mover disposition consistency', () => {
  it('never both moves and leaves an inventory item', () => {
    const byItem = new Map<number, Set<string>>()
    for (const row of ALL_ROWS) {
      byItem.set(row.item, (byItem.get(row.item) ?? new Set()).add(row.disposition))
    }
    const conflicting = [...byItem]
      .filter(([item, dispositions]) => {
        return (
          !PER_FIELD_ITEMS.has(item) &&
          dispositions.has('move') &&
          dispositions.has('not-applicable')
        )
      })
      .map(([item]) => item)
    expect(conflicting).toEqual([])
    // Native chat journals/tables stay local (decision C).
    expect(byItem.get(52)).toEqual(new Set(['not-applicable']))
  })
})
