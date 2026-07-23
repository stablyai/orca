import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SETTINGS_SOURCE = readFileSync(join(__dirname, 'Settings.tsx'), 'utf8')

function sourceBetween(startPattern: string, endPattern: string): string {
  const start = SETTINGS_SOURCE.indexOf(startPattern)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = SETTINGS_SOURCE.indexOf(endPattern, start + startPattern.length)
  expect(end).toBeGreaterThan(start)
  return SETTINGS_SOURCE.slice(start, end)
}

describe('settings repository-hook fanout boundary', () => {
  it('bounds hook probes while retaining request-generation and repository guards', () => {
    const section = sourceBetween(
      'const requestSeq = ++repoHooksRequestSeqRef.current',
      'const scrollTargetId = pendingScrollTargetRef.current'
    )

    expect(SETTINGS_SOURCE).toContain('const REPO_HOOK_PROBE_CONCURRENCY = 4')
    expect(section).toContain('forEachWithConcurrency(neededRepos, REPO_HOOK_PROBE_CONCURRENCY')
    expect(section).not.toMatch(/Promise\.all\(\s*neededRepos\.map/)
    expect(section).toContain('requestSeq !== repoHooksRequestSeqRef.current')
    expect(section).toContain('liveRepoHostIdentities.has(repoHostIdentity)')
  })
})
