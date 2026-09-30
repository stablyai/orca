import { describe, expect, it } from 'vitest'
import { IDLE, buildAttentionByWorktree, resolveAttention } from './smart-attention'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { Worktree } from '../../../../shared/worktree/types'

const NOW = new Date('2026-03-27T12:00:00.000Z').getTime()

const WORKTREE: Worktree = {
  id: 'wt-1',
  repoId: 'repo-1',
  path: '/tmp/wt-1',
  branch: 'refs/heads/wt-1',
  head: 'abc',
  isBare: false,
  isMainWorktree: false,
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  comment: '',
  isUnread: false,
  isPinned: false,
  displayName: 'wt-1',
  sortOrder: 0,
  lastActivityAt: 0
}

const TAB: TerminalTab = {
  id: 'tab-1',
  ptyId: 'pty',
  worktreeId: WORKTREE.id,
  title: 'bash',
  customTitle: null,
  color: null,
  sortOrder: 0,
  createdAt: 0
}

function attentionForTitle(title: string) {
  return buildAttentionByWorktree(
    [WORKTREE],
    { [WORKTREE.id]: [TAB] },
    {},
    { [TAB.id]: { 1: title } },
    { [TAB.id]: ['pty-1'] },
    NOW
  ).get(WORKTREE.id)
}

// Regression guards, hand-built titles: on main a bare name read idle, which ranked the same.
describe('smart attention for a title that only names its agent', () => {
  it('ranks the pane with idle, never as attention', () => {
    for (const title of ['agy', 'grok', 'OpenCode']) {
      expect(attentionForTitle(title)).toEqual(IDLE)
    }
    // Positive control: the same pane with a spinner reaches the working class.
    expect(attentionForTitle('⠋ agy')?.cls).toBe(3)
  })

  it('lets an unreported title pane contribute nothing', () => {
    expect(
      resolveAttention(
        [{ kind: 'title', status: 'unreported', worktreeLastActivityAt: NOW - 1_000 }],
        NOW
      )
    ).toEqual(IDLE)
  })
})
