import { describe, expect, it } from 'vitest'
import type { GitBranchChangeEntry, GitStatusEntry } from '../../../../shared/types'
import {
  buildGitStatusSourceControlTree,
  buildSourceControlTree,
  collectSourceControlTreeFileEntries,
  compactSourceControlTree,
  flattenSourceControlTree
} from './source-control-tree'

function entry(partial: Partial<GitStatusEntry> & { path: string }): GitStatusEntry {
  return {
    status: 'modified',
    area: 'unstaged',
    ...partial
  }
}

function labels(nodes: ReturnType<typeof flattenSourceControlTree>): string[] {
  return nodes.map((node) => `${node.type}:${node.path}`)
}

describe('buildSourceControlTree', () => {
  it('groups changed files by path segments', () => {
    const tree = buildSourceControlTree('unstaged', [
      entry({ path: 'src/components/Button.tsx' }),
      entry({ path: 'src/index.ts' }),
      entry({ path: 'README.md' })
    ])

    expect(labels(flattenSourceControlTree(tree, new Set()))).toEqual([
      'directory:src',
      'directory:src/components',
      'file:src/components/Button.tsx',
      'file:src/index.ts',
      'file:README.md'
    ])
  })

  it('keeps conflict rows ahead of normal rows within a directory', () => {
    const tree = buildGitStatusSourceControlTree('unstaged', [
      entry({ path: 'src/a.ts' }),
      entry({
        path: 'src/z.ts',
        conflictKind: 'both_modified',
        conflictStatus: 'unresolved'
      })
    ])

    expect(labels(flattenSourceControlTree(tree, new Set()))).toEqual([
      'directory:src',
      'file:src/z.ts',
      'file:src/a.ts'
    ])
  })

  it('omits collapsed directory descendants from the visible rows', () => {
    const tree = buildSourceControlTree('staged', [
      entry({ path: 'src/app.ts', area: 'staged' }),
      entry({ path: 'docs/readme.md', area: 'staged' })
    ])
    const collapsed = new Set(['dir::staged::src'])

    expect(labels(flattenSourceControlTree(tree, collapsed))).toEqual([
      'directory:docs',
      'file:docs/readme.md',
      'directory:src'
    ])
  })

  it('collects all descendant file entries for directory actions', () => {
    const tree = buildSourceControlTree('unstaged', [
      entry({ path: 'src/app.ts' }),
      entry({ path: 'src/components/Button.tsx' }),
      entry({ path: 'docs/readme.md' })
    ])

    const src = tree.find((node) => node.type === 'directory' && node.path === 'src')

    expect(src ? collectSourceControlTreeFileEntries(src).map((item) => item.path) : []).toEqual([
      'src/components/Button.tsx',
      'src/app.ts'
    ])
  })

  it('groups committed branch entries with branch-scoped directory keys', () => {
    const entries: GitBranchChangeEntry[] = [
      { path: 'packages/app/src/index.ts', status: 'modified' },
      { path: 'packages/app/package.json', status: 'added' }
    ]
    const tree = buildSourceControlTree('branch', entries)

    expect(labels(flattenSourceControlTree(tree, new Set()))).toEqual([
      'directory:packages',
      'directory:packages/app',
      'directory:packages/app/src',
      'file:packages/app/src/index.ts',
      'file:packages/app/package.json'
    ])
    expect(tree[0].key).toBe('dir::branch::packages')
  })

  it('compacts single-child directory chains for visible source-control rows', () => {
    const tree = buildSourceControlTree('branch', [
      { path: 'src/renderer/src/mockups.css', status: 'modified' },
      { path: 'src/renderer/src/components/App.tsx', status: 'added' }
    ])

    const compacted = compactSourceControlTree(tree)

    expect(labels(flattenSourceControlTree(compacted, new Set()))).toEqual([
      'directory:src/renderer/src',
      'directory:src/renderer/src/components',
      'file:src/renderer/src/components/App.tsx',
      'file:src/renderer/src/mockups.css'
    ])
    expect(compacted[0]).toMatchObject({
      name: 'src/renderer/src',
      path: 'src/renderer/src',
      depth: 0,
      key: 'dir::branch::src/renderer/src'
    })
  })

  it('preserves real branching folders when compacting directory chains', () => {
    const tree = buildSourceControlTree('unstaged', [
      entry({ path: 'src/main/index.ts' }),
      entry({ path: 'src/renderer/index.ts' })
    ])

    const compacted = compactSourceControlTree(tree)

    expect(labels(flattenSourceControlTree(compacted, new Set()))).toEqual([
      'directory:src',
      'directory:src/main',
      'file:src/main/index.ts',
      'directory:src/renderer',
      'file:src/renderer/index.ts'
    ])
  })
})
