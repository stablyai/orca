import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const SOURCE = readFileSync(
  new URL('./github-work-item-background-create.ts', import.meta.url),
  'utf8'
)

function between(startPattern: string, endPattern: string): string {
  const start = SOURCE.indexOf(startPattern)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = SOURCE.indexOf(endPattern, start + startPattern.length)
  expect(end).toBeGreaterThan(start)
  return SOURCE.slice(start, end)
}

describe('GitHub work-item background host routing boundary', () => {
  it('routes setup, trust, and issue-command probes to the selected repository host', () => {
    const flow = between(
      'const repoExecutionHostId = getRepoExecutionHostId(repo)',
      'const request:'
    )

    // Why: these calls cross independent helpers, so source inspection guards
    // against one leg silently reverting to globally focused-host routing.
    expect(flow).toContain('getSettingsForRepoRuntimeOwner(')
    expect(flow).toContain('{ repos: [repo], settings: store.settings }')
    expect(flow).toContain('repoExecutionHostId\n    )')
    expect(flow).toContain('repoExecutionHostId\n        )')
  })
})
