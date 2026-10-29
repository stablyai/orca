import { describe, expect, it } from 'vitest'
import { shouldPollActiveGitStatus } from './passive-macos-app-data-access'
import type { ActiveRightSidebarTab, OpenFile } from '@/store/slices/editor'

const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'

function pollArgs(
  overrides: Partial<Parameters<typeof shouldPollActiveGitStatus>[0]> = {}
): Parameters<typeof shouldPollActiveGitStatus>[0] {
  return {
    activeWorktreeId: 'wt-1',
    worktreePath: '/Users/me/Library/Containers/com.apple.TextEdit/Data/Documents/repo',
    rightSidebarOpen: false,
    rightSidebarTab: 'explorer' as ActiveRightSidebarTab,
    rightSidebarExplorerView: 'files',
    openFiles: [],
    userAgent: MAC,
    ...overrides
  }
}

describe('shouldPollActiveGitStatus', () => {
  it('skips hidden terminal-only polling for macOS app data worktrees', () => {
    expect(shouldPollActiveGitStatus(pollArgs())).toBe(false)
  })

  it('allows polling when Source Control is visible', () => {
    expect(
      shouldPollActiveGitStatus(
        pollArgs({ rightSidebarOpen: true, rightSidebarTab: 'source-control' })
      )
    ).toBe(true)
  })

  it('does not treat Explorer search as a file-tree visibility signal', () => {
    expect(
      shouldPollActiveGitStatus(
        pollArgs({
          rightSidebarOpen: true,
          rightSidebarTab: 'explorer',
          rightSidebarExplorerView: 'search'
        })
      )
    ).toBe(false)
  })

  it('allows polling when an editor file is open in the worktree', () => {
    const openFile: OpenFile = {
      id: 'file-1',
      worktreeId: 'wt-1',
      filePath: '/Users/me/Library/Containers/com.apple.TextEdit/Data/Documents/repo/a.ts',
      relativePath: 'a.ts',
      language: 'typescript',
      isDirty: false,
      mode: 'edit'
    }

    expect(shouldPollActiveGitStatus(pollArgs({ openFiles: [openFile] }))).toBe(true)
  })

  it('keeps existing background polling for ordinary paths', () => {
    expect(shouldPollActiveGitStatus(pollArgs({ worktreePath: '/Users/me/dev/repo' }))).toBe(true)
  })
})
