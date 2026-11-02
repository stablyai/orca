import { describe, expect, it } from 'vitest'
import type { PublishedWorkspaceLayout } from '../../../src/shared/workspace-layout/workspace-layout-published'
import { checkWorkspaceLayoutModelRules } from '../../../src/shared/workspace-layout/workspace-layout-model-rules'
import { LiveLayoutFeed, liveLayoutModels } from './workspace-layout-oracle-feed'

function terminalTab(id: string, leafId: string, ptyId: string) {
  return {
    id,
    kind: 'terminal' as const,
    entityId: id,
    executionHostId: 'local' as const,
    createdAt: 1,
    customTitle: null,
    color: null,
    terminal: { root: { type: 'leaf' as const, leafId }, panes: [{ leafId, ptyId }] }
  }
}

function workspace(
  tabs: PublishedWorkspaceLayout['tabs'],
  groups: PublishedWorkspaceLayout['groups']
): PublishedWorkspaceLayout {
  return { worktreeId: 'wt', groups, tabs, editorFiles: [], browserTabs: [] }
}

describe('LiveLayoutFeed', () => {
  it('applies snapshot, workspace and removed frames and counts them', () => {
    const seen: number[] = []
    const feed = new LiveLayoutFeed((current) => seen.push(current.entries().length))
    const one = workspace([terminalTab('t1', 'l1', 'p1')], [{ id: 'g1', tabIds: ['t1'] }])
    feed.apply({ type: 'snapshot', workspaces: [{ key: 'wt', layout: one }] })
    feed.apply({ type: 'workspace', key: 'wt2', layout: { ...one, worktreeId: 'wt2' } })
    feed.apply({ type: 'removed', key: 'wt' })
    expect(seen).toEqual([1, 2, 1])
    expect(feed.frames).toBe(3)
    expect(feed.entries().map((entry) => [entry.key, entry.hostId])).toEqual([['wt2', 'local']])
  })

  it('keeps an unreadable frame as a stream error', () => {
    const feed = new LiveLayoutFeed(() => {})
    feed.apply({ type: 'snapshot', workspaces: [] })
    feed.apply({ type: 'workspace' })
    expect(feed.ready).toBe(false)
    expect(feed.error).toMatch(/unreadable layout frame/)
  })
})

describe('liveLayoutModels', () => {
  it('lets the model rules see a breach a frame carries', () => {
    const feed = new LiveLayoutFeed(() => {})
    const layout = workspace(
      [terminalTab('t1', 'l1', 'p1'), terminalTab('t2', 'l2', 'p1')],
      [
        { id: 'g1', tabIds: ['t1', 't2'] },
        { id: 'g2', tabIds: ['t2'] }
      ]
    )
    feed.apply({ type: 'snapshot', workspaces: [{ key: 'wt', layout }] })
    const rules = checkWorkspaceLayoutModelRules(liveLayoutModels(feed.entries())).map(
      (violation) => violation.rule
    )
    expect(rules).toEqual(
      expect.arrayContaining(['terminal_in_two_panes', 'tab_in_two_groups', 'group_tree_mismatch'])
    )
  })
})
