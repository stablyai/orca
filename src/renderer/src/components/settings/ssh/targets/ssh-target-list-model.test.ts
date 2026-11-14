import { describe, expect, it } from 'vitest'
import type { SshTarget } from '../../../../../../shared/ssh-types'
import { applySshTargetSelectionClick, sshTargetDisplayOrder } from './ssh-target-list-model'

const host = (id: string, extra: Partial<SshTarget> = {}): SshTarget => ({
  id,
  label: id,
  host: `${id}.example.test`,
  port: 22,
  username: 'dev',
  source: 'ssh-config',
  ...extra
})

describe('applySshTargetSelectionClick', () => {
  const orderedIds = ['a', 'b', 'c', 'd']

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
