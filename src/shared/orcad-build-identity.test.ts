import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { hashOrcadLauncher } from './orcad-build-identity'

let directory = ''
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-entry-identity-'))
})
afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

it('preserves an older single-entry build identity for rollback', () => {
  const entry = join(directory, 'orcad.js')
  writeFileSync(entry, 'old-server')
  expect(hashOrcadLauncher(entry)).toBe(
    createHash('sha256').update('old-server').digest('hex').slice(0, 16)
  )
})

it('keeps the launcher hash older clients expect for both split entry paths', () => {
  const launcher = join(directory, 'orcad.js')
  const server = join(directory, 'orcad-server.js')
  writeFileSync(launcher, 'launcher-a')
  writeFileSync(server, 'server-a')
  const first = hashOrcadLauncher(launcher)
  expect(hashOrcadLauncher(server)).toBe(first)
  expect(first).toBe(createHash('sha256').update('launcher-a').digest('hex').slice(0, 16))
  writeFileSync(launcher, 'launcher-b')
  expect(hashOrcadLauncher(server)).not.toBe(first)
})
