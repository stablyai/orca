import { describe, expect, it } from 'vitest'
import {
  getPerforceCopyName,
  getPerforceCopyWorktreeId,
  isPerforceCopyPath,
  isPerforceCopyWorktreeIdForRepo
} from './perforce-copy-worktree'

const REPO = { id: 'repo-1', path: 'D:\\ws' }

describe('Perforce copy worktree ids', () => {
  it('recognizes a copy folder beside the workspace, and its subfolders', () => {
    expect(isPerforceCopyPath('D:\\ws.wt\\copy-1')).toBe(true)
    expect(isPerforceCopyPath('D:\\ws.wt\\copy-1\\Game')).toBe(true)
    expect(isPerforceCopyPath('/home/me/ws.wt/copy-1/')).toBe(true)
    expect(isPerforceCopyPath('D:\\ws')).toBe(false)
    expect(isPerforceCopyPath('D:\\ws.wt\\name with spaces')).toBe(false)
  })

  it('matches only copies of the same folder project', () => {
    const id = getPerforceCopyWorktreeId(REPO, 'D:\\ws.wt\\copy-1')
    expect(id).toBe('repo-1::D:\\ws.wt\\copy-1')
    expect(isPerforceCopyWorktreeIdForRepo(REPO, id)).toBe(true)
    expect(isPerforceCopyWorktreeIdForRepo({ ...REPO, id: 'repo-2' }, id)).toBe(false)
    expect(isPerforceCopyWorktreeIdForRepo(REPO, 'repo-1::D:\\ws')).toBe(false)
    expect(
      isPerforceCopyWorktreeIdForRepo(
        REPO,
        'repo-1::D:\\ws::workspace:0b6f1b7e-6a43-4f43-9b51-3f7c2a5a1e10'
      )
    ).toBe(false)
  })

  it('reads the copy name from the copy path', () => {
    expect(getPerforceCopyName('D:\\ws.wt\\copy-1\\Game')).toBe('copy-1')
    expect(getPerforceCopyName('D:\\ws')).toBeNull()
  })
})
