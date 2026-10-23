import { describe, expect, it } from 'vitest'
import {
  encodeClaudeProjectPath,
  encodeClaudeProjectPaths,
  findClaudeTranscriptProjectFolder,
  isClaudeProjectDirInScope
} from './claude-project-dir-encoding'

describe('encodeClaudeProjectPath', () => {
  it('emits one dash per non-alphanumeric character rather than per run', () => {
    // The distinction is the whole contract: collapsing runs stops matching real bucket names.
    expect(encodeClaudeProjectPath('/Users/ada/orca/workspaces')).toBe('-Users-ada-orca-workspaces')
    expect(encodeClaudeProjectPath('/Users/ada/.orca/worktrees')).toBe('-Users-ada--orca-worktrees')
  })

  it('encodes a Windows drive path', () => {
    expect(encodeClaudeProjectPath('C:\\Users\\ada\\orca\\workspaces')).toBe(
      'C--Users-ada-orca-workspaces'
    )
    expect(encodeClaudeProjectPath('C:\\')).toBe('C--')
  })

  it('encodes a WSL UNC path', () => {
    expect(encodeClaudeProjectPath('\\\\wsl$\\Ubuntu\\home\\ada\\orca\\workspaces')).toBe(
      '--wsl--Ubuntu-home-ada-orca-workspaces'
    )
  })

  it('drops trailing separators but keeps a bare root', () => {
    expect(encodeClaudeProjectPath('/Users/ada/orca/')).toBe('-Users-ada-orca')
    expect(encodeClaudeProjectPath('/')).toBe('-')
  })

  it('offers the NFC spelling alongside the raw one', () => {
    const nfd = '/Users/ada/cafe\u0301'
    expect(encodeClaudeProjectPaths(nfd)).toEqual([
      encodeClaudeProjectPath(nfd),
      encodeClaudeProjectPath(nfd.normalize('NFC'))
    ])
    expect(encodeClaudeProjectPaths('/Users/ada/cafe')).toEqual(['-Users-ada-cafe'])
  })
})

describe('isClaudeProjectDirInScope', () => {
  it('accepts the prefix itself and its dash-delimited descendants', () => {
    expect(isClaudeProjectDirInScope('-w-orca', ['-w-orca'])).toBe(true)
    expect(isClaudeProjectDirInScope('-w-orca-nautilus', ['-w-orca'])).toBe(true)
  })

  it('rejects a sibling that merely starts with the prefix', () => {
    // Without the boundary, "orca" would absorb every workspace under "orcadyne".
    expect(isClaudeProjectDirInScope('-w-orcadyne-nautilus', ['-w-orca'])).toBe(false)
  })
})

describe('findClaudeTranscriptProjectFolder', () => {
  const transcript = '/Users/ada/.claude-b/projects/-Users-ada-orca/0195f2ce.jsonl'

  it('walks up from a sub-folder the agent moved into to the folder the session is filed under', () => {
    expect(
      findClaudeTranscriptProjectFolder(transcript, ['/Users/ada/orca/src/deep', '/Users/ada'])
    ).toBe('/Users/ada/orca')
  })

  it('keeps a session started in a sub-folder in that sub-folder', () => {
    const subFolderTranscript = '/Users/ada/.claude/projects/-Users-ada-orca-docs/0195f2ce.jsonl'

    expect(
      findClaudeTranscriptProjectFolder(subFolderTranscript, [
        '/Users/ada/orca/docs',
        '/Users/ada/orca'
      ])
    ).toBe('/Users/ada/orca/docs')
  })

  it('falls through to a later candidate when an earlier one lies in another project', () => {
    expect(
      findClaudeTranscriptProjectFolder(transcript, ['/Users/ada/other/src', '/Users/ada/orca'])
    ).toBe('/Users/ada/orca')
  })

  it('keeps Windows separators and the drive root', () => {
    const windowsTranscript = 'C:\\Users\\ada\\.claude\\projects\\C--work-orca\\0195f2ce.jsonl'

    expect(findClaudeTranscriptProjectFolder(windowsTranscript, ['C:\\work\\orca\\src'])).toBe(
      'C:\\work\\orca'
    )
  })

  it('reports nothing when the bucket name fits two distinct folders', () => {
    const ambiguousTranscript = '/home/dev/.claude/projects/-home-dev-foo-bar/0195f2ce.jsonl'

    expect(
      findClaudeTranscriptProjectFolder(ambiguousTranscript, [
        '/home/dev/foo/bar/src',
        '/home/dev/foo-bar'
      ])
    ).toBeNull()
  })

  it('counts a folder reached from two candidates once', () => {
    expect(
      findClaudeTranscriptProjectFolder(transcript, ['/Users/ada/orca/src', '/Users/ada/orca/'])
    ).toBe('/Users/ada/orca')
  })

  it('reports nothing when no candidate matches or the path is not a Claude transcript', () => {
    expect(
      findClaudeTranscriptProjectFolder(transcript, ['/Users/ada/other', undefined])
    ).toBeNull()
    expect(
      findClaudeTranscriptProjectFolder('/tmp/-Users-ada-orca/0195f2ce.jsonl', ['/Users/ada/orca'])
    ).toBeNull()
    expect(findClaudeTranscriptProjectFolder(undefined, ['/Users/ada/orca'])).toBeNull()
    // A UNC walk stops at the share, so a bucket for `/` never names a folder above it.
    expect(
      findClaudeTranscriptProjectFolder('/u/.claude/projects/-/0195f2ce.jsonl', [
        '\\\\srv\\share\\a'
      ])
    ).toBeNull()
  })
})
