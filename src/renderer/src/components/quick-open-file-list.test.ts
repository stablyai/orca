import { describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../../../shared/worktree/types'
import { buildExcludePathPrefixes } from '../../../shared/quick-open-filter'
import {
  cleanRuntimeFileListError,
  getRuntimeFileListTarget,
  getNestedWorktreeExcludePaths,
  getNestedWorktreeExcludeRequest,
  isNestedWorktreePath
} from './quick-open-file-list'

function makeWorktree(id: string, path: string): Worktree {
  return {
    id,
    repoId: 'repo-1',
    displayName: id,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    path,
    head: 'HEAD',
    branch: 'main',
    isBare: false,
    isMainWorktree: false
  }
}

describe('quick-open nested worktree excludes', () => {
  it('treats forward-slash UNC paths as Windows paths', () => {
    expect(isNestedWorktreePath('//Server/Share/Repo', '//server/share/repo/packages/app')).toBe(
      true
    )
    expect(isNestedWorktreePath('//Server/Share/Repo', '//server/share/repo2')).toBe(false)
  })

  it('excludes nested forward-slash UNC worktrees from Quick Open scans', () => {
    expect(
      getNestedWorktreeExcludePaths('root', '//Server/Share/Repo', [
        makeWorktree('root', '//Server/Share/Repo'),
        makeWorktree('nested', '//server/share/repo/packages/app'),
        makeWorktree('sibling', '//server/share/repo2')
      ])
    ).toEqual(['//server/share/repo/packages/app'])
  })

  it('keeps newline-containing nested worktree paths intact for listFiles requests', () => {
    const request = getNestedWorktreeExcludeRequest('root', '/tmp/repo', [
      makeWorktree('root', '/tmp/repo'),
      makeWorktree('nested', '/tmp/repo/linked\nworktree')
    ])

    expect(request.paths).toEqual(['/tmp/repo/linked\nworktree'])
    expect(request.key).toBe('["/tmp/repo/linked\\nworktree"]')
    expect(buildExcludePathPrefixes('/tmp/repo', request.paths)).toEqual(['linked\nworktree'])
  })

  it('can list files for folder workspaces resolved outside registered repo worktrees', () => {
    const folderWorkspace = makeWorktree('folder:workspace-1', '/Users/jenkei/test')
    const target = getRuntimeFileListTarget(folderWorkspace.id, folderWorkspace.path, [])

    expect(target).toEqual({
      canList: true,
      excludeRequest: { paths: [], key: '[]' },
      worktreePath: '/Users/jenkei/test'
    })
  })
})

describe('cleanRuntimeFileListError', () => {
  it('shows only the reason behind the IPC envelope', () => {
    expect(
      cleanRuntimeFileListError(
        new Error("Error invoking remote method 'fs:listFiles': Error: Permission denied")
      )
    ).toBe('Permission denied')
  })

  // Why: this envelope has no `Error: ` after the channel, which the previous local regex
  // required — it rendered the whole wrapper to the user.
  it('strips an envelope whose tail carries no Error: prefix', () => {
    expect(
      cleanRuntimeFileListError(
        new Error("Error invoking remote method 'fs:listFiles': Permission denied")
      )
    ).toBe('Permission denied')
  })

  it('falls back to a sentence, and logs the cause, when the envelope carried no reason', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = new Error("Error invoking remote method 'fs:listFiles': Error")

    expect(cleanRuntimeFileListError(error)).toBe(
      'Orca could not list files here, and the failure did not include a readable reason.'
    )
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unreadable'), error)
    warn.mockRestore()
  })

  it('never renders the envelope, whatever the channel', () => {
    expect(
      cleanRuntimeFileListError(new Error("Error invoking remote method 'x:y': Error: nope"))
    ).not.toContain('invoking remote method')
  })
})
