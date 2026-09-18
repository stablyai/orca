import { describe, expect, it } from 'vitest'
import {
  buildNodeModulesCandidatePaths,
  resolveInstalledPackageVersion
} from './package-json-installed-version'

describe('buildNodeModulesCandidatePaths', () => {
  it('walks from the file directory up to the worktree root, nearest first', () => {
    const candidates = buildNodeModulesCandidatePaths(
      '/repo',
      'packages/foo/package.json',
      'lodash'
    )

    expect(candidates).toEqual([
      {
        filePath: '/repo/packages/foo/node_modules/lodash/package.json',
        relativePath: 'packages/foo/node_modules/lodash/package.json'
      },
      {
        filePath: '/repo/packages/node_modules/lodash/package.json',
        relativePath: 'packages/node_modules/lodash/package.json'
      },
      {
        filePath: '/repo/node_modules/lodash/package.json',
        relativePath: 'node_modules/lodash/package.json'
      }
    ])
  })

  it('yields a single root candidate when package.json is already at the worktree root', () => {
    const candidates = buildNodeModulesCandidatePaths('/repo', 'package.json', 'react')

    expect(candidates).toEqual([
      {
        filePath: '/repo/node_modules/react/package.json',
        relativePath: 'node_modules/react/package.json'
      }
    ])
  })

  it('never produces a candidate above the worktree root', () => {
    const candidates = buildNodeModulesCandidatePaths('/repo', 'a/b/c/package.json', 'pkg')

    for (const candidate of candidates) {
      expect(candidate.filePath.startsWith('/repo')).toBe(true)
    }
    expect(candidates).toHaveLength(4)
  })
})

describe('resolveInstalledPackageVersion', () => {
  it('returns the version from the first candidate that resolves', async () => {
    const seen: string[] = []
    const result = await resolveInstalledPackageVersion({
      worktreeRoot: '/repo',
      relativePath: 'packages/foo/package.json',
      packageName: 'lodash',
      readCandidate: async (candidate) => {
        seen.push(candidate.relativePath)
        if (candidate.relativePath === 'node_modules/lodash/package.json') {
          return JSON.stringify({ version: '4.17.21' })
        }
        throw new Error('ENOENT')
      }
    })

    expect(result).toEqual({ status: 'installed', version: '4.17.21' })
    expect(seen).toEqual([
      'packages/foo/node_modules/lodash/package.json',
      'packages/node_modules/lodash/package.json',
      'node_modules/lodash/package.json'
    ])
  })

  it('reports not-installed when no candidate up to the root resolves', async () => {
    const result = await resolveInstalledPackageVersion({
      worktreeRoot: '/repo',
      relativePath: 'package.json',
      packageName: 'missing-pkg',
      readCandidate: async () => {
        throw new Error('ENOENT')
      }
    })

    expect(result).toEqual({ status: 'not-installed' })
  })

  it('treats an unparseable package.json as not found at that level and keeps walking', async () => {
    const result = await resolveInstalledPackageVersion({
      worktreeRoot: '/repo',
      relativePath: 'packages/foo/package.json',
      packageName: 'lodash',
      readCandidate: async (candidate) => {
        if (candidate.relativePath === 'packages/foo/node_modules/lodash/package.json') {
          return 'not json'
        }
        if (candidate.relativePath === 'node_modules/lodash/package.json') {
          return JSON.stringify({ version: '1.0.0' })
        }
        throw new Error('ENOENT')
      }
    })

    expect(result).toEqual({ status: 'installed', version: '1.0.0' })
  })
})
