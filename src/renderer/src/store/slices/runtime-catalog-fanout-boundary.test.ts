import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPOS_SOURCE = readFileSync(join(__dirname, 'repos.ts'), 'utf8')
const RUNTIME_STATUS_SOURCE = readFileSync(join(__dirname, 'runtime-status.ts'), 'utf8')

function sourceBetween(source: string, startPattern: string, endPattern: string): string {
  const start = source.indexOf(startPattern)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = source.indexOf(endPattern, start + startPattern.length)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('runtime environment fanout boundaries', () => {
  it('bounds every all-host catalog fetch', () => {
    const sections = [
      sourceBetween(REPOS_SOURCE, 'fetchReposForAllHosts: async', 'fetchProjectGroups: async'),
      sourceBetween(
        REPOS_SOURCE,
        'fetchProjectGroupsForAllHosts: async',
        'fetchFolderWorkspaces: async'
      ),
      sourceBetween(
        REPOS_SOURCE,
        'fetchFolderWorkspacesForAllHosts: async',
        'getFolderWorkspacePathStatusCacheKey:'
      )
    ]

    expect(REPOS_SOURCE).toContain('const RUNTIME_CATALOG_FETCH_CONCURRENCY = 4')
    for (const section of sections) {
      expect(section).toContain('forEachWithConcurrency(')
      expect(section).toContain('RUNTIME_CATALOG_FETCH_CONCURRENCY')
      expect(section).not.toMatch(/Promise\.all\(\s*environments\.map/)
    }
  })

  it('bounds startup status probes while retaining all-settled behavior', () => {
    const section = sourceBetween(
      RUNTIME_STATUS_SOURCE,
      'hydrateRuntimeEnvironmentStatuses: async',
      '\n  }\n})'
    )

    expect(RUNTIME_STATUS_SOURCE).toContain('const RUNTIME_STATUS_PROBE_CONCURRENCY = 4')
    expect(section).toContain('mapSettledWithConcurrency(')
    expect(section).toContain('RUNTIME_STATUS_PROBE_CONCURRENCY')
    expect(section).not.toMatch(/Promise\.allSettled\(\s*environments\.map/)
  })
})
