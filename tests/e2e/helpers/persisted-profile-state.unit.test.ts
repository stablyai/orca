import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { openProfileStateDatabase } from '../../../src/main/persistence/profile-state/profile-state-database'
import { importProfileStateJson } from '../../../src/main/persistence/profile-state/profile-state-documents'
import { acquireProfileStateRuntimeAdmission } from '../../../src/main/persistence/profile-state/profile-state-access'
import { mutateStoppedProfileState, readPersistedProfileState } from './persisted-profile-state'

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

it('reads committed SQLite and changes stopped fixtures without rewriting retained JSON', () => {
  const item = fixture()
  const before = readFileSync(item.dataFile)
  expect(readPersistedProfileState(item.root)).toEqual(item.state)
  const result = mutateStoppedProfileState(item.root, (state) => {
    expect(() => acquireProfileStateRuntimeAdmission(item.root)).toThrow()
    state.fixture = { changed: true }
    return 'complete'
  })
  expect(result).toBe('complete')
  expect(readPersistedProfileState(item.root)).toEqual({
    ...item.state,
    fixture: { changed: true }
  })
  expect(readFileSync(item.dataFile)).toEqual(before)
})

it('refuses a fixture write while a runtime is admitted and releases the refused owner', () => {
  const item = fixture()
  const runtime = acquireProfileStateRuntimeAdmission(item.root)
  try {
    expect(() => mutateStoppedProfileState(item.root, () => {})).toThrow()
    expect(readPersistedProfileState(item.root)).toEqual(item.state)
  } finally {
    runtime.release()
  }
  expect(() => mutateStoppedProfileState(item.root, () => {})).not.toThrow()
})

it('does not create missing authority when a test points at the wrong profile', () => {
  const item = fixture()
  rmSync(item.databaseFile)
  expect(() => mutateStoppedProfileState(item.root, () => {})).toThrow()
  expect(existsSync(item.databaseFile)).toBe(false)
  const runtime = acquireProfileStateRuntimeAdmission(item.root)
  runtime.release()
})
