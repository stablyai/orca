import { describe, expect, it } from 'vitest'
import type { SshTarget } from '../../../../shared/ssh-types'
import {
  applySshTargetSelectionClick,
  filterSshTargets,
  groupSshTargetsBySource,
  planSshBulkRemove,
  sshIdentityFileName,
  sshTargetDisplayOrder,
  sshTargetGroupCheckState
} from './ssh-target-list-model'
import { summarizeSshBulkRemove } from './ssh-bulk-remove-summary'

const host = (id: string, extra: Partial<SshTarget> = {}): SshTarget => ({
  id,
  label: id,
  host: `${id}.example.test`,
  port: 22,
  username: 'dev',
  source: 'ssh-config',
  ...extra
})

describe('groupSshTargetsBySource', () => {
  it('groups a legacy target without a source by the config-sync rule', () => {
    const groups = groupSshTargetsBySource([
      // The old import shape: alias kept as label/configHost, host is the resolved HostName.
      host('legacy-import', {
        source: undefined,
        label: 'box',
        configHost: 'box',
        host: '10.0.0.5'
      }),
      // A legacy manual target lacks `source` too, but doesn't match that shape.
      host('legacy-manual', { source: undefined, label: 'My box', host: 'box.example.test' }),
      host('mine', { source: 'manual' }),
      host('synced', { source: 'ssh-config' })
    ])
    expect(groups.map((group) => [group.id, group.targets.map((t) => t.id)])).toEqual([
      ['ssh-config', ['legacy-import', 'synced']],
      ['manual', ['legacy-manual', 'mine']]
    ])
  })

  it('omits an empty group', () => {
    expect(groupSshTargetsBySource([host('mine', { source: 'manual' })]).map((g) => g.id)).toEqual([
      'manual'
    ])
  })
})

describe('filterSshTargets', () => {
  it('matches label, host and user case-insensitively', () => {
    const targets = [host('alpha'), host('beta', { host: 'Build.internal' })]
    expect(filterSshTargets(targets, 'BUILD').map((t) => t.id)).toEqual(['beta'])
    expect(filterSshTargets(targets, '  ').map((t) => t.id)).toEqual(['alpha', 'beta'])
  })
})

describe('applySshTargetSelectionClick', () => {
  const orderedIds = ['a', 'b', 'c', 'd']

  it('toggles a single row without Shift', () => {
    const next = applySshTargetSelectionClick({
      selected: new Set(['a']),
      orderedIds,
      anchorId: 'a',
      clickedId: 'c',
      shiftKey: false
    })
    expect([...next]).toEqual(['a', 'c'])
  })

  it('selects the visible range between the anchor and the Shift-clicked row', () => {
    const next = applySshTargetSelectionClick({
      selected: new Set(['d']),
      orderedIds,
      anchorId: 'd',
      clickedId: 'b',
      shiftKey: true
    })
    expect([...next].sort()).toEqual(['b', 'c', 'd'])
  })

  it('clears the range when the Shift-clicked row was selected', () => {
    const next = applySshTargetSelectionClick({
      selected: new Set(['a', 'b', 'c']),
      orderedIds,
      anchorId: 'a',
      clickedId: 'c',
      shiftKey: true
    })
    expect([...next]).toEqual([])
  })

  it('falls back to one row when the anchor is filtered out', () => {
    const next = applySshTargetSelectionClick({
      selected: new Set(),
      orderedIds,
      anchorId: 'gone',
      clickedId: 'c',
      shiftKey: true
    })
    expect([...next]).toEqual(['c'])
  })
})

describe('Shift-click over grouped rows', () => {
  it('walks the rendered order, so a range never jumps across groups', () => {
    const targets = [
      host('cfg-a', { source: 'ssh-config' }),
      host('man-b', { source: 'manual' }),
      host('cfg-c', { source: 'ssh-config' })
    ]
    const orderedIds = sshTargetDisplayOrder(targets)
    expect(orderedIds).toEqual(['cfg-a', 'cfg-c', 'man-b'])
    const next = applySshTargetSelectionClick({
      selected: new Set(['cfg-a']),
      orderedIds,
      anchorId: 'cfg-a',
      clickedId: 'cfg-c',
      shiftKey: true
    })
    expect([...next].sort()).toEqual(['cfg-a', 'cfg-c'])
  })
})

describe('sshTargetGroupCheckState', () => {
  it('is tri-state', () => {
    expect(sshTargetGroupCheckState(new Set(), ['a', 'b'])).toBe(false)
    expect(sshTargetGroupCheckState(new Set(['a']), ['a', 'b'])).toBe('indeterminate')
    expect(sshTargetGroupCheckState(new Set(['a', 'b', 'x']), ['a', 'b'])).toBe(true)
  })
})

describe('planSshBulkRemove and its summary', () => {
  it('skips hosts that need their own decision and names them in one summary', () => {
    const plan = planSshBulkRemove(
      [host('a'), host('prod-bastion'), host('dev'), host('b')],
      (target) =>
        target.id === 'prod-bastion' ? 'managed-server' : target.id === 'dev' ? 'workspaces' : null
    )
    expect(plan.removable.map((t) => t.id)).toEqual(['a', 'b'])
    const summary = summarizeSshBulkRemove({
      removedCount: 2,
      skipped: plan.skipped,
      failed: []
    })
    expect(summary.tone).toBe('neutral')
    expect(summary.title).toBe('2 removed · 2 skipped')
    expect(summary.description).toContain('prod-bastion has an Orca server.')
    expect(summary.description).toContain('dev has workspaces.')
  })

  it('reports an all-failed run as an error', () => {
    const summary = summarizeSshBulkRemove({
      removedCount: 0,
      skipped: [],
      failed: [{ label: 'a', message: 'boom' }]
    })
    expect(summary).toEqual({ tone: 'error', title: '1 failed', description: 'a: boom' })
  })

  it('is a plain success when every host was removed', () => {
    expect(summarizeSshBulkRemove({ removedCount: 3, skipped: [], failed: [] })).toEqual({
      tone: 'success',
      title: '3 removed'
    })
  })
})

describe('sshIdentityFileName', () => {
  it('shows only the key file name on any platform', () => {
    expect(sshIdentityFileName('/Users/me/.ssh/id_rsa')).toBe('id_rsa')
    expect(sshIdentityFileName('C:\\Users\\me\\.ssh\\id_ed25519')).toBe('id_ed25519')
    expect(sshIdentityFileName('  ')).toBeNull()
    expect(sshIdentityFileName(undefined)).toBeNull()
  })
})
