import { describe, expect, it } from 'vitest'
import type { AttentionTarget } from './next-attention-queue'
import { pickNextAttentionTarget, type AttentionPosition } from './next-attention-target'

const LEAF = '11111111-1111-4111-8111-111111111111'

function pane(workspace: string, tab: string): AttentionTarget {
  return {
    workspaceIdentity: `local|${workspace}`,
    worktreeId: workspace,
    executionHostId: 'local',
    level: 'pane',
    tabKind: 'terminal',
    terminalTabId: tab,
    unifiedTabId: `u-${tab}`,
    leafId: LEAF
  }
}

function at(workspace: string | null, tab: string | null = null, leafId = LEAF): AttentionPosition {
  return {
    workspaceIdentity: workspace === null ? null : `local|${workspace}`,
    unifiedTabId: tab === null ? null : `u-${tab}`,
    terminalTabId: tab,
    leafId
  }
}

describe('pickNextAttentionTarget', () => {
  it('returns null for an empty queue', () => {
    expect(pickNextAttentionTarget([], at('a', 't'))).toBeNull()
  })

  it('goes to the topmost target from a calm place or with nothing active', () => {
    const queue = [pane('a', 't1'), pane('b', 't2')]

    expect(pickNextAttentionTarget(queue, at('c', 'calm'))).toBe(queue[0])
    expect(pickNextAttentionTarget(queue, at(null))).toBe(queue[0])
  })

  it('steps from a target to the next one and wraps from the last', () => {
    const queue = [pane('a', 't1'), pane('a', 't2'), pane('b', 't3')]

    expect(pickNextAttentionTarget(queue, at('a', 't1'))).toBe(queue[1])
    expect(pickNextAttentionTarget(queue, at('a', 't2'))).toBe(queue[2])
    expect(pickNextAttentionTarget(queue, at('b', 't3'))).toBe(queue[0])
  })

  it('stays on a single target the user is already at', () => {
    const queue = [pane('a', 't1')]

    expect(pickNextAttentionTarget(queue, at('a', 't1'))).toBe(queue[0])
  })

  it('matches a tab-level target by tab and a workspace-level one by workspace', () => {
    const tabTarget: AttentionTarget = { ...pane('a', 't1'), level: 'tab', leafId: undefined }
    const workspaceTarget: AttentionTarget = {
      workspaceIdentity: 'local|b',
      worktreeId: 'b',
      level: 'workspace'
    }
    const queue = [tabTarget, workspaceTarget, pane('c', 't3')]

    expect(pickNextAttentionTarget(queue, at('a', 't1', 'other-leaf'))).toBe(workspaceTarget)
    expect(pickNextAttentionTarget(queue, at('b', 'anything'))).toBe(queue[2])
  })

  it('returns to the top after a read target drops out of the queue', () => {
    const a = pane('a', 't1')
    const b = pane('b', 't2')
    const c = pane('c', 't3')
    const d = pane('d', 't4')
    const visits: string[] = []
    let unread = new Set(['b', 'c'])
    let position = at('calm', 'x')
    for (let press = 0; press < 6; press += 1) {
      const queue = [a, b, c, d].filter(
        (target) => target === a || target === d || unread.has(target.worktreeId)
      )
      const next = pickNextAttentionTarget(queue, position)!
      visits.push(next.worktreeId)
      position = at(next.worktreeId, next.terminalTabId)
      // Showing an unread target reads it; blocked ones stay until answered.
      unread = new Set([...unread].filter((id) => id !== next.worktreeId))
    }

    expect(visits).toEqual(['a', 'b', 'a', 'c', 'a', 'd'])
  })
})
