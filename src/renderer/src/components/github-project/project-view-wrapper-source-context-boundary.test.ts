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

describe('ProjectViewWrapper GitHub source context boundary', () => {
  it('passes the matched repo source context into the repo-backed GitHub dialog', () => {
    const source = componentSource('ProjectViewWrapper.tsx')
    const contextSection = sourceBetween(
      source,
      'const resolvedDialogRepo = resolvedDialogRepoItem',
      'const resolvedMissingRepoDialogs'
    )
    const dialogSection = sourceBetween(source, '<GitHubItemDialog', 'onUse={(item) => {')

    expect(source).toContain('buildTaskSourceContextFromRepo')
    expect(contextSection).toContain("provider: 'github'")
    expect(contextSection).toContain('repo: resolvedDialogRepo')
    expect(dialogSection).toContain('sourceContext={resolvedDialogSourceContext}')
  })
})
