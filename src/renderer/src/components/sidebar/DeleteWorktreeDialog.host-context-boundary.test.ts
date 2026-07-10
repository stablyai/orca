import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SOURCE = readFileSync(join(__dirname, 'DeleteWorktreeDialog.tsx'), 'utf8')

function sourceBetween(source: string, startPattern: string, endPattern: string): string {
  const start = source.indexOf(startPattern)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = source.indexOf(endPattern, start + startPattern.length)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('DeleteWorktreeDialog host-context boundaries', () => {
  it('preloads git status from the selected worktree owner instead of the focused host', () => {
    const effect = sourceBetween(
      SOURCE,
      'const statusTargets = deleteTargets.filter(',
      'return () => {'
    )

    expect(effect).toContain('getSettingsForWorktreeRuntimeOwner')
    expect(effect).toContain('worktreesByRepo: useAppStore.getState().worktreesByRepo')
    expect(effect).toContain('item.id')
    expect(effect).not.toContain('settings,\n        worktreeId: item.id')
  })
})
