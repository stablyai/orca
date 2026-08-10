import { describe, expect, it } from 'vitest'
import {
  GIT_STAGED_DISCARD_OPERATION_VERSION,
  GIT_STAGED_DISCARD_RUNTIME_CAPABILITY,
  GIT_STAGED_DISCARD_UPDATE_REQUIRED_MESSAGE
} from './protocol-version'
import {
  assertGitStagedDiscardCapability,
  gitStagedDiscardArgs,
  gitStagedDiscardStatusArgs,
  resolveGitStagedDiscardPaths,
  supportsGitStagedDiscardOperation
} from './git-staged-discard-operation'

describe('staged discard operation', () => {
  it('accepts only the exact runtime capability', () => {
    expect(() =>
      assertGitStagedDiscardCapability({
        capabilities: [GIT_STAGED_DISCARD_RUNTIME_CAPABILITY]
      })
    ).not.toThrow()
  })

  it.each([
    undefined,
    null,
    {},
    { capabilities: GIT_STAGED_DISCARD_RUNTIME_CAPABILITY },
    { capabilities: ['git.staged-discard.v2'] },
    { capabilities: [GIT_STAGED_DISCARD_RUNTIME_CAPABILITY, 1] }
  ])('rejects absent, malformed, or mismatched runtime capabilities', (status) => {
    expect(() => assertGitStagedDiscardCapability(status)).toThrow(
      GIT_STAGED_DISCARD_UPDATE_REQUIRED_MESSAGE
    )
  })

  it('accepts only the exact owner operation version', () => {
    expect(
      supportsGitStagedDiscardOperation({
        stagedDiscardOperationVersion: GIT_STAGED_DISCARD_OPERATION_VERSION
      })
    ).toBe(true)
    expect(supportsGitStagedDiscardOperation(undefined)).toBe(false)
    expect(supportsGitStagedDiscardOperation({ stagedDiscardOperationVersion: '1' })).toBe(false)
    expect(supportsGitStagedDiscardOperation({ stagedDiscardOperationVersion: 2 })).toBe(false)
  })

  it('builds one combined index and worktree restore', () => {
    expect(gitStagedDiscardArgs([':(literal)a.ts', ':(literal)b.ts'])).toEqual([
      'restore',
      '--source=HEAD',
      '--staged',
      '--worktree',
      '--',
      ':(literal)a.ts',
      ':(literal)b.ts'
    ])
    expect(gitStagedDiscardStatusArgs()).toEqual([
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=no',
      '--renames'
    ])
  })

  it('adds rename sources and reports unmerged records', () => {
    expect(
      resolveGitStagedDiscardPaths('R  renamed.txt\0file.txt\0UU conflict.txt\0', [
        'renamed.txt',
        'conflict.txt'
      ])
    ).toEqual({
      paths: ['renamed.txt', 'file.txt', 'conflict.txt'],
      hasConflict: true
    })
  })

  it('ignores unrelated conflicts and copy sources', () => {
    expect(
      resolveGitStagedDiscardPaths(
        'C  copied.txt\0source.txt\0UU unrelated.txt\0M  selected.txt\0',
        ['selected.txt', 'copied.txt']
      )
    ).toEqual({ paths: ['selected.txt', 'copied.txt'], hasConflict: false })
  })
})
