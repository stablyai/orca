import { describe, expect, it } from 'vitest'
import {
  JJ_WORKSPACE_LIST_TEMPLATE,
  buildJjWorkspaceAddArgs,
  buildJjWorkspaceForgetArgs,
  buildJjWorkspaceListArgs,
  buildJjWorkspaceRootArgs,
  jujutsuWorkspaceNameForPath,
  parseJujutsuWorkspaceList,
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

  it('builds forget args from a workspace name', () => {
    expect(buildJjWorkspaceForgetArgs('feature')).toEqual(['workspace', 'forget', 'feature'])
  })

  it('builds workspace root args', () => {
    expect(buildJjWorkspaceRootArgs()).toEqual(['workspace', 'root'])
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

  it('rewrites a single remote/branch ref into a jj remote-bookmark revset', () => {
    expect(resolveJujutsuBaseRevision('origin/main')).toBe('main@origin')
  })

  it('passes through a bare local branch name', () => {
    expect(resolveJujutsuBaseRevision('main')).toBe('main')
  })

  it('passes through an explicit jj remote-bookmark revset unchanged', () => {
    expect(resolveJujutsuBaseRevision('main@origin')).toBe('main@origin')
  })

  it('passes through refs with multiple slashes verbatim', () => {
    expect(resolveJujutsuBaseRevision('refs/heads/feature')).toBe('refs/heads/feature')
  })
})
