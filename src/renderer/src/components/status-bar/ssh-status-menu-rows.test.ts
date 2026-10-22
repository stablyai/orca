import { describe, expect, it } from 'vitest'
import {
  findSshHostMatches,
  splitSshStatusMenuRows,
  type SshStatusMenuTarget
} from './ssh-status-menu-rows'

function target(id: string, status: SshStatusMenuTarget['status']): SshStatusMenuTarget {
  return { id, label: id, status }
}

describe('splitSshStatusMenuRows', () => {
  it('keeps every connected and in-progress host and caps only idle ones', () => {
    const rows = splitSshStatusMenuRows(
      [
        target('a', 'disconnected'),
        target('b', 'disconnected'),
        target('c', 'disconnected'),
        target('d', 'auth-failed'),
        target('e', 'connected')
      ],
      { idleRowLimit: 1 }
    )
    expect(rows.connected.map((row) => row.id)).toEqual(['e'])
    expect(rows.inactive.map((row) => row.id)).toEqual(['d', 'a'])
    expect(rows.hiddenIdleCount).toBe(2)
  })

  it('fills the idle cap with hosts that own projects before the rest of the config', () => {
    const rows = splitSshStatusMenuRows(
      [target('a', 'disconnected'), target('b', 'disconnected'), target('c', 'disconnected')],
      { projectHostIds: new Set(['c']), idleRowLimit: 2 }
    )
    expect(rows.inactive.map((row) => row.id)).toEqual(['c', 'a'])
    expect(rows.hiddenIdleCount).toBe(1)
  })

  it('keeps config order and hides nothing at or under the limit', () => {
    const rows = splitSshStatusMenuRows(
      [target('a', 'disconnected'), target('b', 'error'), target('c', 'disconnected')],
      { projectHostIds: new Set(['c']), idleRowLimit: 2 }
    )
    expect(rows.hiddenIdleCount).toBe(0)
    expect(rows.inactive.map((row) => row.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('findSshHostMatches', () => {
  it('ranks an exact name ahead of any number of prefix and substring matches', () => {
    const targets = [
      ...Array.from({ length: 30 }, (_, index) => target(`prod-${index}`, 'disconnected')),
      target('east-prod', 'disconnected'),
      target('PROD', 'disconnected')
    ]
    const { shown, hiddenCount } = findSshHostMatches(targets, ' prod ', 5)
    expect(shown[0]?.id).toBe('PROD')
    expect(shown).toHaveLength(5)
    expect(hiddenCount).toBe(27)
    expect(findSshHostMatches(targets, 'east', 5).shown.map((row) => row.id)).toEqual(['east-prod'])
  })

  it('leaves out connected hosts, which the menu already lists', () => {
    const { shown } = findSshHostMatches(
      [target('web-1', 'connected'), target('web-2', 'disconnected')],
      'web'
    )
    expect(shown.map((row) => row.id)).toEqual(['web-2'])
  })
})
