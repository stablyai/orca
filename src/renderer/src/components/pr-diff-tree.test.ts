import { describe, it, expect } from 'vitest'
import { buildDiffTree } from './pr-diff-tree'
import type { GitHubPRFile } from '../../../shared/types'

describe('buildDiffTree', () => {
  it('builds a hierarchical tree from flat paths', () => {
    const files: GitHubPRFile[] = [
      { path: 'src/app.ts', status: 'modified', additions: 1, deletions: 1, isBinary: false },
      {
        path: 'src/components/button.tsx',
        status: 'added',
        additions: 10,
        deletions: 0,
        isBinary: false
      },
      {
        path: 'src/components/input.tsx',
        status: 'added',
        additions: 5,
        deletions: 0,
        isBinary: false
      },
      { path: 'README.md', status: 'modified', additions: 2, deletions: 0, isBinary: false }
    ]

    const tree = buildDiffTree(files)

    // src/ (dir) and README.md (file) should be at root due to sort (dirs first)
    expect(tree).toHaveLength(2)
    expect(tree[0].name).toBe('src')
    expect(tree[1].name).toBe('README.md')

    const src = tree[0]
    if (src.kind !== 'dir') {
      throw new Error('src should be a directory')
    }

    // components/ (dir) and app.ts (file) should be inside src
    expect(src.children).toHaveLength(2)
    expect(src.children[0].name).toBe('components')
    expect(src.children[1].name).toBe('app.ts')

    const components = src.children[0]
    if (components.kind !== 'dir') {
      throw new Error('components should be a directory')
    }
    expect(components.children).toHaveLength(2)
    expect(components.children[0].name).toBe('button.tsx')
    expect(components.children[1].name).toBe('input.tsx')
  })

  it('compacts single-child directory chains', () => {
    const files: GitHubPRFile[] = [
      { path: 'a/b/c/d.ts', status: 'added', additions: 1, deletions: 0, isBinary: false }
    ]

    const tree = buildDiffTree(files)
    expect(tree).toHaveLength(1)
    expect(tree[0].name).toBe('a/b/c')

    const abc = tree[0]
    if (abc.kind !== 'dir') {
      throw new Error('a/b/c should be a directory')
    }
    expect(abc.children).toHaveLength(1)
    expect(abc.children[0].name).toBe('d.ts')
  })

  it('does not compact when there are multiple children', () => {
    const files: GitHubPRFile[] = [
      { path: 'a/b/c.ts', status: 'added', additions: 1, deletions: 0, isBinary: false },
      { path: 'a/d/e.ts', status: 'added', additions: 1, deletions: 0, isBinary: false }
    ]

    const tree = buildDiffTree(files)
    expect(tree).toHaveLength(1)
    expect(tree[0].name).toBe('a')

    const a = tree[0]
    if (a.kind !== 'dir') {
      throw new Error('a should be a directory')
    }
    expect(a.children).toHaveLength(2)
    expect(a.children[0].name).toBe('b')
    expect(a.children[1].name).toBe('d')
  })

  it('returns an empty array for an empty file list', () => {
    expect(buildDiffTree([])).toEqual([])
  })

  it('handles root-level-only files with no directories', () => {
    const files: GitHubPRFile[] = [
      { path: 'README.md', status: 'modified', additions: 1, deletions: 0, isBinary: false },
      { path: 'package.json', status: 'modified', additions: 2, deletions: 1, isBinary: false }
    ]

    const tree = buildDiffTree(files)
    expect(tree).toHaveLength(2)
    expect(tree.every((n) => n.kind === 'file')).toBe(true)
    expect(tree[0].name).toBe('package.json')
    expect(tree[1].name).toBe('README.md')
  })

  it('preserves renamed file metadata in leaf nodes', () => {
    const files: GitHubPRFile[] = [
      {
        path: 'src/utils/new-name.ts',
        oldPath: 'src/helpers/old-name.ts',
        status: 'renamed',
        additions: 0,
        deletions: 0,
        isBinary: false
      }
    ]

    const tree = buildDiffTree(files)
    expect(tree).toHaveLength(1)

    const src = tree[0]
    if (src.kind !== 'dir') {
      throw new Error('expected dir')
    }
    expect(src.name).toBe('src/utils')

    const leaf = src.children[0]
    if (leaf.kind !== 'file') {
      throw new Error('expected file')
    }
    expect(leaf.name).toBe('new-name.ts')
    expect(leaf.file.oldPath).toBe('src/helpers/old-name.ts')
  })

  it('handles backslash-separated paths', () => {
    const files: GitHubPRFile[] = [
      { path: 'src\\lib\\index.ts', status: 'added', additions: 5, deletions: 0, isBinary: false }
    ]

    const tree = buildDiffTree(files)
    expect(tree).toHaveLength(1)
    expect(tree[0].name).toBe('src/lib')

    const dir = tree[0]
    if (dir.kind !== 'dir') {
      throw new Error('expected dir')
    }
    expect(dir.children).toHaveLength(1)
    expect(dir.children[0].name).toBe('index.ts')
  })
})
