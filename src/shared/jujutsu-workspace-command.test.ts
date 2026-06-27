import { describe, expect, it } from 'vitest'
import {
  JJ_WORKSPACE_LIST_TEMPLATE,
  buildJjRemoteListArgs,
  buildJjWorkspaceAddArgs,
  buildJjWorkspaceForgetArgs,
  buildJjWorkspaceListArgs,
  buildJjWorkspaceListDefaultArgs,
  buildJjWorkspaceRootArgs,
  jujutsuWorkspaceNameForPath,
  parseJujutsuRemoteNames,
  parseJujutsuWorkspaceList,
  parseJujutsuWorkspaceListDefault,
  resolveJujutsuBaseRevision
} from './jujutsu-workspace-command'

describe('buildJjWorkspaceAddArgs', () => {
  it('emits a bare add with only the path when no name or base is given', () => {
    expect(buildJjWorkspaceAddArgs({ worktreePath: '/repo/.worktrees/feature' })).toEqual([
      'workspace',
      'add',
      '/repo/.worktrees/feature'
    ])
  })

  it('includes --name and --revision in jj flag order before the path', () => {
    expect(
      buildJjWorkspaceAddArgs({
        worktreePath: '/repo/.worktrees/feature',
        name: 'feature',
        baseRevision: 'main@origin'
      })
    ).toEqual([
      'workspace',
      'add',
      '--name',
      'feature',
      '--revision',
      'main@origin',
      '/repo/.worktrees/feature'
    ])
  })

  it('ignores blank name and base values', () => {
    expect(
      buildJjWorkspaceAddArgs({
        worktreePath: '/repo/ws',
        name: '   ',
        baseRevision: '  '
      })
    ).toEqual(['workspace', 'add', '/repo/ws'])
  })
})

describe('buildJjWorkspace* arg builders', () => {
  it('builds list args with the path-bearing template', () => {
    expect(buildJjWorkspaceListArgs()).toEqual([
      'workspace',
      'list',
      '--template',
      JJ_WORKSPACE_LIST_TEMPLATE
    ])
  })

  it('builds the template-less list args for the older-jj fallback', () => {
    expect(buildJjWorkspaceListDefaultArgs()).toEqual(['workspace', 'list'])
  })

  it('builds forget args from a workspace name', () => {
    expect(buildJjWorkspaceForgetArgs('feature')).toEqual(['workspace', 'forget', 'feature'])
  })

  it('builds workspace root args', () => {
    expect(buildJjWorkspaceRootArgs()).toEqual(['workspace', 'root'])
  })

  it('builds git remote list args', () => {
    expect(buildJjRemoteListArgs()).toEqual(['git', 'remote', 'list'])
  })
})

describe('parseJujutsuWorkspaceListDefault', () => {
  it('parses names from `name: summary` lines with empty paths', () => {
    const stdout = 'default: qpv abc main | msg\nfeature: rly def | (no description set)\n'
    expect(parseJujutsuWorkspaceListDefault(stdout)).toEqual([
      { name: 'default', path: '' },
      { name: 'feature', path: '' }
    ])
  })

  it('skips blank lines', () => {
    expect(parseJujutsuWorkspaceListDefault('\ndefault: x\n\n')).toEqual([
      { name: 'default', path: '' }
    ])
  })
})

describe('parseJujutsuRemoteNames', () => {
  it('takes the first whitespace-delimited token per line', () => {
    const stdout = 'origin https://example.com/a.git\nupstream git@example.com:b.git\n'
    expect(parseJujutsuRemoteNames(stdout)).toEqual(['origin', 'upstream'])
  })

  it('returns an empty array for empty output', () => {
    expect(parseJujutsuRemoteNames('')).toEqual([])
  })
})

describe('parseJujutsuWorkspaceList', () => {
  it('parses tab-separated name/path lines', () => {
    const stdout = 'default\t/repo\nfeature\t/repo/.worktrees/feature\n'
    expect(parseJujutsuWorkspaceList(stdout)).toEqual([
      { name: 'default', path: '/repo' },
      { name: 'feature', path: '/repo/.worktrees/feature' }
    ])
  })

  it('tolerates CRLF line endings and trailing whitespace', () => {
    const stdout = 'default\t/repo  \r\nfeature\t/repo/ws\r\n'
    expect(parseJujutsuWorkspaceList(stdout)).toEqual([
      { name: 'default', path: '/repo' },
      { name: 'feature', path: '/repo/ws' }
    ])
  })

  it('keeps paths that contain spaces or further tabs intact after the first tab', () => {
    const stdout = 'ws\t/repo/my work/ws\n'
    expect(parseJujutsuWorkspaceList(stdout)).toEqual([{ name: 'ws', path: '/repo/my work/ws' }])
  })

  it('skips blank and tab-less lines', () => {
    const stdout = '\ndefault\t/repo\nname-only-no-path\n\n'
    expect(parseJujutsuWorkspaceList(stdout)).toEqual([{ name: 'default', path: '/repo' }])
  })

  it('returns an empty array for empty output', () => {
    expect(parseJujutsuWorkspaceList('')).toEqual([])
  })
})

describe('jujutsuWorkspaceNameForPath', () => {
  it('returns the leaf directory for a posix path', () => {
    expect(jujutsuWorkspaceNameForPath('/repo/.worktrees/feature')).toBe('feature')
  })

  it('returns the leaf directory for a windows path', () => {
    expect(jujutsuWorkspaceNameForPath('C:\\repo\\.worktrees\\feature')).toBe('feature')
  })

  it('ignores trailing separators', () => {
    expect(jujutsuWorkspaceNameForPath('/repo/.worktrees/feature/')).toBe('feature')
  })
})

describe('resolveJujutsuBaseRevision', () => {
  it('returns undefined for empty input', () => {
    expect(resolveJujutsuBaseRevision(undefined)).toBeUndefined()
    expect(resolveJujutsuBaseRevision('   ')).toBeUndefined()
  })

  it('rewrites a remote/branch ref to a jj remote-bookmark revset when the prefix is a known remote', () => {
    expect(resolveJujutsuBaseRevision('origin/main', ['origin'])).toBe('main@origin')
  })

  it('does NOT rewrite a slash ref when the prefix is not a known remote (local bookmark safety)', () => {
    // `feature/foo` is a valid local jj bookmark — must not become `foo@feature`.
    expect(resolveJujutsuBaseRevision('feature/foo', ['origin'])).toBe('feature/foo')
  })

  it('passes a slash ref through verbatim when no remotes are known', () => {
    expect(resolveJujutsuBaseRevision('origin/main')).toBe('origin/main')
  })

  it('passes through a bare local branch name', () => {
    expect(resolveJujutsuBaseRevision('main', ['origin'])).toBe('main')
  })

  it('passes through an explicit jj remote-bookmark revset unchanged', () => {
    expect(resolveJujutsuBaseRevision('main@origin', ['origin'])).toBe('main@origin')
  })

  it('passes through refs with multiple slashes verbatim', () => {
    expect(resolveJujutsuBaseRevision('refs/heads/feature', ['refs'])).toBe('refs/heads/feature')
  })
})
