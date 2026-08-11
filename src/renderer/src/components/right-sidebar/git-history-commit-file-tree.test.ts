import { describe, expect, it } from 'vitest'
import { buildGitHistoryCommitFileTree } from './source-control/sync/git-history-commit-file-tree'
import { flattenSourceControlTree } from './source-control-tree'
import type { GitBranchChangeEntry } from '../../../../shared/git-diff-compare-types'

function entry(
  path: string,
  status: GitBranchChangeEntry['status'] = 'modified'
): GitBranchChangeEntry {
  return { path, status }
}

const KOTLIN_ADAPTER =
  'compensation/adapter/src/main/kotlin/com/karrotpay/fleamarket/compensation/adapter'

describe('buildGitHistoryCommitFileTree', () => {
  // The point of the feature: every package segment stays its own row. Compacting
  // single-child chains would collapse this to one directory node.
  it('keeps every directory segment as its own node', () => {
    const roots = buildGitHistoryCommitFileTree([
      entry(`${KOTLIN_ADAPTER}/CompensationTargetQueryAdapter.kt`, 'added')
    ])

    const names: string[] = []
    let cursor = roots
    while (cursor.length === 1 && cursor[0].type === 'directory') {
      names.push(cursor[0].name)
      cursor = cursor[0].children
    }

    expect(names).toEqual([
      'compensation',
      'adapter',
      'src',
      'main',
      'kotlin',
      'com',
      'karrotpay',
      'fleamarket',
      'compensation',
      'adapter'
    ])
    expect(cursor).toHaveLength(1)
    expect(cursor[0].type).toBe('file')
  })

  it('assigns depth from real path depth so indentation matches the hierarchy', () => {
    const roots = buildGitHistoryCommitFileTree([
      entry(`${KOTLIN_ADAPTER}/CompensationTargetQueryAdapter.kt`, 'added')
    ])
    const rows = flattenSourceControlTree(roots, new Set())

    expect(rows.at(0)?.depth).toBe(0)
    expect(rows.at(-1)?.depth).toBe(10)
  })

  it('shares common ancestors between sibling files instead of duplicating them', () => {
    const roots = buildGitHistoryCommitFileTree([
      entry(`${KOTLIN_ADAPTER}/CompensationTargetQueryAdapter.kt`, 'added'),
      entry(`${KOTLIN_ADAPTER}/TargetIdResolverAdapter.kt`, 'renamed')
    ])
    const rows = flattenSourceControlTree(roots, new Set())

    expect(rows.filter((node) => node.type === 'directory')).toHaveLength(10)
    expect(rows.filter((node) => node.type === 'file')).toHaveLength(2)
  })

  it('orders directories before files and aggregates file counts', () => {
    const roots = buildGitHistoryCommitFileTree([
      entry('compensation/build.gradle.kts'),
      entry('compensation/domain/Compensation.kt'),
      entry('compensation/domain/CompensationTarget.kt', 'added')
    ])

    expect(roots).toHaveLength(1)
    const compensation = roots[0]
    expect(compensation.type).toBe('directory')
    if (compensation.type !== 'directory') {
      return
    }

    expect(compensation.fileCount).toBe(3)
    expect(compensation.children.map((child) => child.type)).toEqual(['directory', 'file'])
  })

  it('hides descendants of a collapsed directory', () => {
    const roots = buildGitHistoryCommitFileTree([
      entry('compensation/domain/Compensation.kt'),
      entry('port/EscrowIdResolverPort.kt', 'deleted')
    ])
    const collapsedKey = roots.find((node) => node.name === 'compensation')?.key
    expect(collapsedKey).toBeDefined()

    const rows = flattenSourceControlTree(roots, new Set([collapsedKey!]))

    expect(rows.map((node) => node.name)).toEqual([
      'compensation',
      'port',
      'EscrowIdResolverPort.kt'
    ])
  })

  it('ignores entries whose path has no usable segments', () => {
    expect(buildGitHistoryCommitFileTree([entry('')])).toEqual([])
  })

  describe('compact folders', () => {
    it('collapses a single-child chain into one row', () => {
      const roots = buildGitHistoryCommitFileTree(
        [entry(`${KOTLIN_ADAPTER}/CompensationTargetQueryAdapter.kt`, 'added')],
        true
      )
      const rows = flattenSourceControlTree(roots, new Set())
      const directories = rows.filter((node) => node.type === 'directory')

      expect(directories).toHaveLength(1)
      expect(directories[0].name).toBe(KOTLIN_ADAPTER)
      expect(rows.at(-1)?.depth).toBe(1)
    })

    it('stops compacting where the tree branches', () => {
      const roots = buildGitHistoryCommitFileTree(
        [entry('compensation/domain/Compensation.kt'), entry('compensation/port/Escrow.kt')],
        true
      )
      const rows = flattenSourceControlTree(roots, new Set())

      expect(rows.filter((node) => node.type === 'directory').map((node) => node.name)).toEqual([
        'compensation',
        'domain',
        'port'
      ])
    })

    it('leaves the hierarchy untouched when disabled', () => {
      const entries = [entry(`${KOTLIN_ADAPTER}/CompensationTargetQueryAdapter.kt`, 'added')]

      expect(buildGitHistoryCommitFileTree(entries, false)).toEqual(
        buildGitHistoryCommitFileTree(entries)
      )
    })
  })
})
