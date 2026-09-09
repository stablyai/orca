import { describe, expect, it } from 'vitest'
import { resolveHydratedEditorFileSelection } from './hydrated-editor-file-selection'
import { resolveHydratedEditorFrontmatter } from './hydrated-editor-frontmatter'
import { migrateEditorFileId } from './hydrated-editor-file-ids'

type SelectionInput = Parameters<typeof resolveHydratedEditorFileSelection>[0]
function referenceSelection(args: SelectionInput) {
  const select = (worktreeId: string) => {
    const persisted = migrateEditorFileId(
      args.migrations,
      worktreeId,
      args.persistedActiveFileIds[worktreeId]
    )
    return persisted &&
      args.openFiles.some((file) => file.id === persisted && file.worktreeId === worktreeId)
      ? persisted
      : (args.openFiles.find((file) => file.worktreeId === worktreeId)?.id ?? null)
  }
  return {
    activeFileId: args.activeWorktreeId ? select(args.activeWorktreeId) : null,
    activeFileIdByWorktree: Object.fromEntries(
      [...args.validWorktreeIds].flatMap((worktreeId) => {
        const fileId = select(worktreeId)
        return fileId ? [[worktreeId, fileId]] : []
      })
    )
  }
}

function referenceFrontmatter(
  visibility: Record<string, boolean>,
  openIds: Set<string>,
  migrations: Record<string, Map<string, string>>
) {
  const hidden = new Map<string, boolean>()
  for (const [id, visible] of Object.entries(visibility)) {
    if (visible) {
      continue
    }
    if (openIds.has(id)) {
      hidden.set(id, false)
    }
    for (const migration of Object.values(migrations)) {
      const target = migration.get(id)
      if (target && openIds.has(target)) {
        hidden.set(target, false)
      }
    }
  }
  return Object.fromEntries(hidden)
}

class CountedMigrations extends Map<string, string> {
  reads = 0
  override get(key: string): string | undefined {
    this.reads++
    return super.get(key)
  }
  override *[Symbol.iterator](): MapIterator<[string, string]> {
    for (const entry of super[Symbol.iterator]()) {
      this.reads++
      yield entry
    }
  }
}

describe('hydrated editor selection', () => {
  it('indexes files once across many workspace selections', () => {
    const count = 1_000
    let reads = 0
    const files = Array.from({ length: count }, (_, index) => ({
      get id() {
        reads++
        return `file-${index}`
      },
      get worktreeId() {
        reads++
        return `folder:${index}`
      }
    }))
    const args: SelectionInput = {
      openFiles: files,
      validWorktreeIds: new Set(files.map((file) => file.worktreeId)),
      activeWorktreeId: 'folder:999',
      persistedActiveFileIds: Object.fromEntries(files.map((file) => [file.worktreeId, file.id])),
      migrations: {}
    }
    reads = 0
    const expected = referenceSelection(args)
    expect(reads).toBeGreaterThan((count * count) / 2)
    reads = 0
    expect(resolveHydratedEditorFileSelection(args)).toEqual(expected)
    expect(reads).toBeLessThan(count * 6)
  })

  it('preserves owner checks, migration, first-file fallbacks and empty IDs', () => {
    for (let sample = 0; sample < 100; sample++) {
      const args: SelectionInput = {
        openFiles: Array.from({ length: 20 }, (_, index) => ({
          id: (index + sample) % 7 ? `file-${(index + sample) % 9}` : '',
          worktreeId: `wt-${(index * 3 + sample) % 5}`
        })),
        activeWorktreeId: sample % 3 ? `wt-${sample % 7}` : null,
        validWorktreeIds: new Set(Array.from({ length: 7 }, (_, index) => `wt-${index}`)),
        persistedActiveFileIds: {
          'wt-0': 'legacy',
          'wt-1': 'file-3',
          'wt-2': 'absent',
          'wt-3': ''
        },
        migrations: { 'wt-0': new Map([['legacy', 'file-1']]) }
      }
      expect(resolveHydratedEditorFileSelection(args)).toEqual(referenceSelection(args))
    }
  })
})

describe('hydrated frontmatter migration', () => {
  it('avoids workspace-by-override fanout', () => {
    const count = 1_000
    const visibility = Object.fromEntries(
      Array.from({ length: count }, (_, i) => [`old-${i}`, false])
    )
    const openIds = new Set(Array.from({ length: count }, (_, i) => `new-${i}`))
    const migrations = Object.fromEntries(
      Array.from({ length: count }, (_, i) => [
        `wt-${i}`,
        new CountedMigrations([[`old-${i}`, `new-${i}`]])
      ])
    )
    const expected = referenceFrontmatter(visibility, openIds, migrations)
    expect(Object.values(migrations).reduce((sum, map) => sum + map.reads, 0)).toBe(count * count)
    for (const map of Object.values(migrations)) {
      map.reads = 0
    }
    expect(resolveHydratedEditorFrontmatter(visibility, openIds, migrations)).toEqual(expected)
    expect(Object.values(migrations).reduce((sum, map) => sum + map.reads, 0)).toBe(count)
  })

  it('does no migration scan without overrides and one lookup for a sparse override', () => {
    const map = new CountedMigrations(
      Array.from({ length: 10_000 }, (_, i) => [`old-${i}`, `new-${i}`])
    )
    const ids = new Set(['new-9999'])
    expect(resolveHydratedEditorFrontmatter({ 'old-0': true }, ids, { wt: map })).toEqual({})
    expect(map.reads).toBe(0)
    expect(resolveHydratedEditorFrontmatter({ 'old-9999': false }, ids, { wt: map })).toEqual({
      'new-9999': false
    })
    expect(map.reads).toBe(1)
  })

  it('preserves insertion order, multiple owners, direct IDs and missing targets', () => {
    for (let sample = 0; sample < 50; sample++) {
      const visibility = Object.fromEntries(
        Array.from({ length: 15 }, (_, i) => [`file-${i}`, (i + sample) % 4 === 0])
      )
      const ids = new Set(Array.from({ length: 10 }, (_, i) => `file-${(i + sample) % 16}`))
      const migrations = Object.fromEntries(
        Array.from({ length: 5 }, (_, w) => [
          `wt-${w}`,
          new Map(
            Array.from({ length: 8 }, (_, i) => [
              `file-${(i + w) % 15}`,
              `file-${(i + sample) % 17}`
            ])
          )
        ])
      )
      expect(Object.entries(resolveHydratedEditorFrontmatter(visibility, ids, migrations))).toEqual(
        Object.entries(referenceFrontmatter(visibility, ids, migrations))
      )
    }
  })
})
