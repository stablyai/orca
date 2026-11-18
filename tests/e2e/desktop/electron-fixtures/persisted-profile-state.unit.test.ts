import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { openProfileStateDatabase } from '../../../../src/main/persistence/profile-state/database/profile-state-database'
import { importProfileStateJson } from '../../../../src/main/persistence/profile-state/documents/profile-state-documents'
import { acquireProfileStateRuntimeAdmission } from '../../../../src/main/persistence/profile-state/access/profile-state-access'
import { mutateStoppedProfileState } from './persisted-profile-state'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'orca-persisted-test-state-'))
  roots.push(root)
  const directory = join(root, 'profiles', 'local-default')
  mkdirSync(directory, { recursive: true })
  const databaseFile = join(directory, 'profile-state.db')
  const dataFile = join(directory, 'orca-data.json')
  const state = { settings: { sealed: 'ciphertext' }, unknown: { kept: null, output: '\ud800' } }
  const opened = openProfileStateDatabase(databaseFile, 'local-default')
  try {
    importProfileStateJson(opened.db, JSON.stringify(state))
  } finally {
    opened.db.close()
  }
  writeFileSync(dataFile, '{"retained":"old migration snapshot"}')
  return { root, databaseFile, dataFile, state }
}

it('does not create missing authority when a test points at the wrong profile', () => {
  const item = fixture()
  rmSync(item.databaseFile)
  expect(() => mutateStoppedProfileState(item.root, () => {})).toThrow()
  expect(existsSync(item.databaseFile)).toBe(false)
  const runtime = acquireProfileStateRuntimeAdmission(item.root)
  runtime.release()
})
