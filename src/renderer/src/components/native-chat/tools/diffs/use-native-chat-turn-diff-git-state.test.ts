import { expect, it } from 'vitest'
import { nativeChatTurnDiffGitState } from './use-native-chat-turn-diff-git-state'
import type { NativeChatTurnDiff } from '../../../../../../shared/native-chat/tools/native-chat-turn-diffs'
import type { GitStatusEntry } from '../../../../../../shared/git/status/git-status-types'

const WORKTREE = '/repo/wt'

function diffFile(path: string, added: number, removed: number, truncated = false) {
  return {
    path,
    added,
    removed,
    truncated,
    target: { messageId: 'm1', editKey: 'e1', fileIndex: 0 },
    edits: []
  }
}

function turnDiff(...files: ReturnType<typeof diffFile>[]): NativeChatTurnDiff {
  return { files, added: 0, removed: 0, truncated: false }
}

function entry(path: string, added?: number, removed?: number): GitStatusEntry {
  return { path, status: 'modified', area: 'unstaged', added, removed }
}

it('flags an uncommitted path whose live diff counts differ from the recorded diff', () => {
  const state = nativeChatTurnDiffGitState(
    turnDiff(diffFile('src/a.ts', 10, 2), diffFile('src/b.ts', 5, 5)),
    [entry('src/a.ts', 14, 2), entry('src/b.ts', 5, 5)],
    undefined,
    WORKTREE,
    undefined,
    undefined
  )
  expect(state?.uncommittedPaths).toEqual(new Set(['src/a.ts', 'src/b.ts']))
  expect(state?.divergedPaths).toEqual(new Set(['src/a.ts']))
})

it('sums counts across staging areas before comparing', () => {
  const staged: GitStatusEntry = {
    path: 'src/a.ts',
    status: 'modified',
    area: 'staged',
    added: 4,
    removed: 0
  }
  const unstaged: GitStatusEntry = {
    path: 'src/a.ts',
    status: 'modified',
    area: 'unstaged',
    added: 6,
    removed: 2
  }
  const state = nativeChatTurnDiffGitState(
    turnDiff(diffFile('src/a.ts', 10, 2)),
    [staged, unstaged],
    undefined,
    WORKTREE,
    undefined,
    undefined
  )
  expect(state?.divergedPaths.size).toBe(0)
})

it('claims no divergence when any matching entry lacks counts', () => {
  const staged: GitStatusEntry = {
    path: 'src/a.ts',
    status: 'modified',
    area: 'staged',
    added: 4,
    removed: 0
  }
  const unstaged: GitStatusEntry = { path: 'src/a.ts', status: 'modified', area: 'unstaged' }
  const state = nativeChatTurnDiffGitState(
    turnDiff(diffFile('src/a.ts', 10, 2)),
    [staged, unstaged],
    undefined,
    WORKTREE,
    undefined,
    undefined
  )
  expect(state?.divergedPaths.size).toBe(0)
})

it('claims no divergence for truncated or count-less entries', () => {
  const state = nativeChatTurnDiffGitState(
    turnDiff(diffFile('src/a.ts', 10, 2, true), diffFile('src/b.ts', 5, 5)),
    [entry('src/a.ts', 99, 99), entry('src/b.ts')],
    undefined,
    WORKTREE,
    undefined,
    undefined
  )
  expect(state?.divergedPaths.size).toBe(0)
})
