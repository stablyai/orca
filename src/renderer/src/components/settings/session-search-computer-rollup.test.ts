import { expect, it } from 'vitest'
import {
  isTurnOnableSessionSearchState,
  orderSessionSearchServers,
  type SessionSearchComputerEntry
} from './session-search-computer-rollup'

const fleet: SessionSearchComputerEntry[] = [
  { id: 'local', name: 'Local Mac', state: 'on' },
  { id: 'a', name: 'build-01', state: 'on' },
  { id: 'b', name: 'gpu-a', state: 'off' },
  { id: 'c', name: 'linux 1', state: 'offline' },
  { id: 'd', name: 'nas', state: 'offline' },
  { id: 'e', name: 'm4 air', state: 'needs-update' },
  { id: 'f', name: 'probing', state: 'checking' }
]

it('will not offer to turn on a computer it cannot reach or that is too old', () => {
  expect(isTurnOnableSessionSearchState('off')).toBe(true)
  for (const state of ['on', 'offline', 'needs-update', 'checking'] as const) {
    expect(isTurnOnableSessionSearchState(state)).toBe(false)
  }
  expect(fleet.filter((entry) => isTurnOnableSessionSearchState(entry.state))).toHaveLength(1)
})

it('orders reachable and working first, then by name inside each group', () => {
  const ordered = orderSessionSearchServers([
    { id: 'f', name: 'probing', state: 'checking' },
    { id: 'c', name: 'linux 1', state: 'offline' },
    { id: 'e', name: 'm4 air', state: 'needs-update' },
    { id: 'b', name: 'gpu-a', state: 'off' },
    { id: 'a', name: 'build-01', state: 'on' },
    { id: 'z', name: 'aa-on', state: 'on' }
  ])
  expect(ordered.map((entry) => entry.name)).toEqual([
    'aa-on',
    'build-01',
    'gpu-a',
    'probing',
    'm4 air',
    'linux 1'
  ])
})
