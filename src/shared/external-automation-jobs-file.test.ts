import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  EXTERNAL_AUTOMATION_JOBS_FILE_MAX_BYTES,
  EXTERNAL_AUTOMATION_JOBS_MAX_ENTRIES,
  readExternalAutomationJobsFile
} from './external-automation-jobs-file'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempFile(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'orca-automation-jobs-'))
  tempDirs.push(dir)
  return join(dir, name)
}

describe('readExternalAutomationJobsFile', () => {
  it('preserves supported jobs shapes below the limits', async () => {
    const wrappedPath = await tempFile('wrapped.json')
    const rootPath = await tempFile('root.json')
    await writeFile(wrappedPath, JSON.stringify({ jobs: [{ id: 'one' }] }))
    await writeFile(rootPath, JSON.stringify([{ id: 'two' }]))

    await expect(
      readExternalAutomationJobsFile(wrappedPath, { allowRootArray: false })
    ).resolves.toEqual([{ id: 'one' }])
    await expect(
      readExternalAutomationJobsFile(rootPath, { allowRootArray: true })
    ).resolves.toEqual([{ id: 'two' }])
  })

  it('rejects oversized sparse files before reading them wholesale', async () => {
    const path = await tempFile('oversized.json')
    await writeFile(path, '')
    await truncate(path, EXTERNAL_AUTOMATION_JOBS_FILE_MAX_BYTES + 64 * 1024 * 1024)

    await expect(readExternalAutomationJobsFile(path, { allowRootArray: true })).rejects.toThrow(
      'jobs file exceeds the 8 MiB memory limit'
    )
  })

  it('rejects excessive job counts explicitly', async () => {
    const path = await tempFile('too-many.json')
    await writeFile(
      path,
      JSON.stringify(Array.from({ length: EXTERNAL_AUTOMATION_JOBS_MAX_ENTRIES + 1 }, () => null))
    )

    await expect(readExternalAutomationJobsFile(path, { allowRootArray: true })).rejects.toThrow(
      'more than 10,000 jobs'
    )
  })

  it('rejects structural amplification before parsing jobs', async () => {
    const path = await tempFile('amplified.json')
    await writeFile(path, '{"jobs":[{},{}]}')

    await expect(
      readExternalAutomationJobsFile(path, {
        allowRootArray: false,
        structureLimits: { structuralTokens: 7, nestingDepth: 3 }
      })
    ).rejects.toThrow('JSON structure')
  })
})
