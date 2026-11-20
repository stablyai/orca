import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { stageCredentialFile } from '../../main/credentials/credential-file-io'
import { hardenWindowsCredentialPath } from './windows-credential-file-io'
import { createFakeWindowsSecurity } from './windows-security-addon.test-fixture'
import {
  resetWindowsSecurityLoadForTests,
  setWindowsSecurityForTests
} from './windows-security-addon'

let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-private-stage-'))
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
})
afterEach(() => {
  vi.restoreAllMocks()
  resetWindowsSecurityLoadForTests()
  rmSync(directory, { recursive: true, force: true })
})

it('never writes secret bytes into a stage substituted after native verification', async () => {
  const fake = createFakeWindowsSecurity()
  const getDacl = fake.getDaclAces
  fake.getDaclAces = (path) => {
    const aces = getDacl(path)
    if (path.endsWith('.tmp')) {
      rmSync(path)
      writeFileSync(path, '')
    }
    return aces
  }
  setWindowsSecurityForTests(fake)
  const target = join(directory, 'credential')
  await stageCredentialFile(target, 'secret-token', { requirePrivateWindowsFile: true })
  expect(readFileSync(target, 'utf8')).toBe('')
})

it('shares one directory repair across concurrent callers', async () => {
  const count = 30
  const fake = createFakeWindowsSecurity()
  const repair = vi.spyOn(fake, 'setDaclSddl')
  setWindowsSecurityForTests(fake)
  expect(
    await Promise.all(
      Array.from({ length: count }, () => hardenWindowsCredentialPath(directory, true))
    )
  ).toEqual(Array(count).fill(true))
  expect(repair).toHaveBeenCalledTimes(1)
})

it('releases a failed shared repair so the next allowed attempt can recover', async () => {
  const fake = createFakeWindowsSecurity()
  const repair = vi.spyOn(fake, 'setDaclSddl').mockImplementationOnce(() => {
    throw new Error('temporary lock')
  })
  const clock = vi.spyOn(performance, 'now').mockReturnValue(0)
  setWindowsSecurityForTests(fake)
  expect(
    await Promise.all(Array.from({ length: 3 }, () => hardenWindowsCredentialPath(directory, true)))
  ).toEqual([false, false, false])
  clock.mockReturnValue(60_001)
  expect(await hardenWindowsCredentialPath(directory, true)).toBe(true)
  expect(repair).toHaveBeenCalledTimes(2)
})
