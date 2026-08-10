import { describe, expect, it } from 'vitest'
import { classifyGitDiscardPaths, gitDiscardStatusArgs } from './git-discard-status'

describe('classifyGitDiscardPaths', () => {
  it('distinguishes intent-to-add from staged additions and untracked paths', () => {
    const output = [
      ' A intent.txt',
      'A  staged-empty.txt',
      '?? untracked.txt',
      '!! ignored.txt',
      ''
    ].join('\0')

    expect(
      Object.fromEntries(
        classifyGitDiscardPaths(output, [
          'intent.txt',
          'staged-empty.txt',
          'untracked.txt',
          'ignored.txt'
        ])
      )
    ).toEqual({
      'ignored.txt': 'untracked',
      'intent.txt': 'intent-to-add',
      'staged-empty.txt': 'tracked',
      'untracked.txt': 'untracked'
    })
  })

  it('treats modified, renamed, deleted, and conflicted paths as tracked', () => {
    const output = [
      'MM modified',
      'R  renamed',
      'old-name',
      ' D deleted',
      'UU conflicted',
      ''
    ].join('\0')

    expect(
      Object.fromEntries(
        classifyGitDiscardPaths(output, ['modified', 'renamed', 'deleted', 'conflicted'])
      )
    ).toEqual({
      conflicted: 'tracked',
      deleted: 'tracked',
      modified: 'tracked',
      renamed: 'tracked'
    })
  })

  it('maps descendant records and normalizes selected WSL separators without rewriting records', () => {
    const output = [' M src/file.ts', ' A intent/new.ts', ''].join('\0')

    expect(
      Object.fromEntries(
        classifyGitDiscardPaths(output, ['src', 'intent\\new.ts'], (selectedPath) =>
          selectedPath.replaceAll('\\', '/')
        )
      )
    ).toEqual({ 'intent\\new.ts': 'intent-to-add', src: 'tracked' })

    expect(Object.fromEntries(classifyGitDiscardPaths(' M a\\b\0', ['a/b']))).toEqual({
      'a/b': 'untracked'
    })
  })

  it('builds a literal, bounded status query', () => {
    expect(gitDiscardStatusArgs(['[a].ts'], (path) => `:(literal)${path}`)).toEqual([
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
      '--ignored',
      '--no-renames',
      '--',
      ':(literal)[a].ts'
    ])
  })
})
