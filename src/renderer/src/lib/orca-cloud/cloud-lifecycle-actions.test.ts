import { describe, expect, it } from 'vitest'
import {
  cloudLifecycleState,
  cloudLifecycleStateFromServer,
  cloudWorkspaceActions,
  type CloudLifecycleAction
} from './cloud-lifecycle-actions'

const ALL: CloudLifecycleAction[] = [
  'wake',
  'sleep',
  'restart',
  'archive',
  'unarchive',
  'moveToComputer',
  'delete',
  'archiveInsteadOfDelete',
  'remoteDesktop',
  'newTab',
  'openIn',
  'copyPath',
  'copyName',
  'organize'
]
const offered = (state: Parameters<typeof cloudWorkspaceActions>[0]) =>
  ALL.filter((action) => cloudWorkspaceActions(state).offers(action))

describe('LIFECYCLE-MATRIX', () => {
  it('archived offers only what works without a VM', () => {
    expect(offered('archived')).toEqual([
      'unarchive',
      'moveToComputer',
      'delete',
      'copyName',
      'organize'
    ])
  })

  it('asleep wakes, archives and moves, and never offers a live-VM-only tab', () => {
    const asleep = cloudWorkspaceActions('asleep')
    expect(asleep.allows('wake')).toBe(true)
    expect(asleep.allows('archive')).toBe(true)
    expect(asleep.allows('moveToComputer')).toBe(true)
    expect(asleep.offers('remoteDesktop')).toBe(false)
    expect(asleep.offers('sleep')).toBe(false)
  })

  it('a move in flight greys the actions that would race it', () => {
    const moving = cloudWorkspaceActions('moving')
    for (const action of ['archive', 'delete', 'moveToComputer', 'sleep'] as const) {
      expect(moving.availability(action)).toBe('disabled')
    }
  })

  it('reads the same columns from the dot state and from the server status', () => {
    expect(cloudLifecycleState('archived')).toBe('archived')
    expect(cloudLifecycleState('sleeping')).toBe('asleep')
    expect(cloudLifecycleState('running', { moving: true })).toBe('moving')
    expect(cloudLifecycleState('running', { deleting: true })).toBe('deleted')
    expect(cloudLifecycleStateFromServer('suspended', null)).toBe('asleep')
    expect(cloudLifecycleStateFromServer('suspended', 123)).toBe('archived')
  })
})
