import { describe, expect, it } from 'vitest'
import { presence, workspace } from '../../cloud-workspaces/cloud-workspaces.test-fixture'
import { teammateActivities, workspaceDisplayLabel } from './team-activity'

describe('teammateActivities (PARITY-FOLLOW)', () => {
  it('says what each teammate is doing now, by workspace name, in roster order', () => {
    const rows = teammateActivities(
      ['user_grace', 'user_linus', 'user_alan'],
      [
        workspace({ title: 'Checkout retries', presence: [presence('user_grace', 'typing')] }),
        workspace({ title: 'Ledger', presence: [presence('user_linus')] })
      ]
    )
    expect(rows).toEqual([
      { userId: 'user_grace', activity: { state: 'typing', workspaceLabel: 'Checkout retries' } },
      { userId: 'user_linus', activity: { state: 'viewing', workspaceLabel: 'Ledger' } },
      { userId: 'user_alan', activity: null }
    ])
  })

  it('prefers typing anywhere over viewing elsewhere, then the most recent', () => {
    const viewing = { ...presence('user_grace'), at: 2_000 }
    const typing = { ...presence('user_grace', 'typing'), at: 1_000 }
    const rows = teammateActivities(
      ['user_grace'],
      [
        workspace({ title: 'A', presence: [viewing] }),
        workspace({ title: 'B', presence: [typing] })
      ]
    )
    expect(rows[0]?.activity).toEqual({ state: 'typing', workspaceLabel: 'B' })
    const newer = teammateActivities(
      ['user_grace'],
      [
        workspace({ title: 'Old', presence: [{ ...presence('user_grace'), at: 1 }] }),
        workspace({ title: 'New', presence: [{ ...presence('user_grace'), at: 5 }] })
      ]
    )
    expect(newer[0]?.activity?.workspaceLabel).toBe('New')
  })

  it('reads no activity before the first list arrives', () => {
    expect(teammateActivities(['user_grace'], null)).toEqual([
      { userId: 'user_grace', activity: null }
    ])
  })

  it('names a workspace by title, then W-number, then repo', () => {
    expect(workspaceDisplayLabel(workspace({ title: 'Checkout', number: 7 }))).toBe('Checkout')
    expect(workspaceDisplayLabel(workspace({ title: '  ', number: 582 }))).toBe('W-582')
    expect(
      workspaceDisplayLabel(
        workspace({
          title: null,
          number: null,
          repo: { url: 'https://github.com/acme/payments.git', branch: null }
        })
      )
    ).toBe('acme/payments')
  })
})
