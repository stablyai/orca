import { describe, expect, it } from 'vitest'
import type { SshTarget } from '../../../../shared/ssh-types'
import {
  applySshTargetSelectionClick,
  groupSshTargetsBySource,
  sshTargetDisplayOrder
} from './ssh-target-list-model'

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
})

describe('applySshTargetSelectionClick', () => {
  const orderedIds = ['a', 'b', 'c', 'd']

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
