import { describe, expect, it } from 'vitest'
import { resolveSourceLocationTarget } from './source-map-paths'

describe('resolveSourceLocationTarget', () => {
  it('resolves exact source-map files inside the current worktree with line metadata', () => {
    const result = resolveSourceLocationTarget({
      projectPath: '/repo',
      files: ['src/index.ts', 'src/users/service.ts'],
      location: { pattern: 'src/users/service.ts', line: 7, endLine: 11 }
    })

    expect(result).toEqual({
      absolutePath: '/repo/src/users/service.ts',
      relativePath: 'src/users/service.ts',
      line: 7,
      endLine: 11
    })
  })

  it('resolves glob source maps against the file list without leaving the worktree', () => {
    const result = resolveSourceLocationTarget({
      projectPath: '/repo',
      files: ['src/index.ts', 'src/users/service.ts', '../outside.ts'],
      location: { pattern: 'src/**/*.ts' }
    })

    expect(result).toEqual({
      absolutePath: '/repo/src/index.ts',
      relativePath: 'src/index.ts'
    })
  })

  it('returns a clear miss instead of opening unresolved glob or parent paths', () => {
    expect(
      resolveSourceLocationTarget({
        projectPath: '/repo',
        files: ['src/index.ts'],
        location: { pattern: '../secret.ts' }
      })
    ).toEqual({ error: "Source pattern '../secret.ts' is outside the worktree." })

    expect(
      resolveSourceLocationTarget({
        projectPath: '/repo',
        files: ['src/index.ts'],
        location: { pattern: 'app/**/*.ts' }
      })
    ).toEqual({ error: "No file in this worktree matches source pattern 'app/**/*.ts'." })
  })
})
