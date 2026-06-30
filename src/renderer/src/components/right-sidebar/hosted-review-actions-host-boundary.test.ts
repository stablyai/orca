import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const COMPONENT_ROOT = __dirname

function componentSource(relativePath: string): string {
  return readFileSync(join(COMPONENT_ROOT, relativePath), 'utf8')
}

function sourceBetween(source: string, startPattern: string, endPattern: string): string {
  const start = source.indexOf(startPattern)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = source.indexOf(endPattern, start + startPattern.length)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('Hosted review action host boundaries', () => {
  it('routes GitHub merge actions through the review host context', () => {
    const source = componentSource('use-hosted-review-actions.ts')
    const mergeSection = sourceBetween(
      source,
      'const handleMerge = useCallback(',
      'const handleAutoMerge = useCallback(async () => {'
    )

    expect(source).toContain('ownerSettings')
    expect(source).toContain('getActiveRuntimeTarget(')
    expect(source).toContain('callRuntimeRpc')
    expect(source).toContain('reviewTarget.kind === \'environment\'')
    expect(mergeSection).toContain("'github.mergePR'")
    expect(source).toContain("'github.setPRAutoMerge'")
    expect(source).toContain("'github.updatePRState'")
  })
})
