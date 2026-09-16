import { describe, expect, it } from 'vitest'
import {
  getCodexAccountDisplayLabel,
  type CodexDisplayAccount
} from './codex-account-display-label'

const email = 'same@example.com'
const labels = (accounts: CodexDisplayAccount[]) =>
  accounts.map((account) => getCodexAccountDisplayLabel(account, accounts))

describe('Codex account display labels', () => {
  it('names personal and enterprise workspaces sharing an email', () => {
    expect(
      labels([
        { id: 'personal', email, workspaceLabel: 'Personal (Plus)' },
        { id: 'enterprise', email, workspaceLabel: 'Enterprise' }
      ])
    ).toEqual([`${email} (Personal (Plus))`, `${email} (Enterprise)`])
  })

  it.each([null, 'Enterprise'])(
    'disambiguates missing or duplicate workspace names: %s',
    (workspaceLabel) => {
      const accounts = [
        { id: '12345678-a', email, workspaceLabel },
        { id: '12345678-b', email, workspaceLabel }
      ]
      const result = labels(accounts)
      expect(new Set(result).size).toBe(2)
      expect(result[0]).toContain('12345678-a')
      expect(result[1]).toContain('12345678-b')
      expect(labels(accounts.toReversed())).toEqual(result.toReversed())
    }
  )

  it('handles legacy and remote summaries without workspace metadata', () => {
    expect(
      labels([
        { id: 'account-a', email },
        { id: 'account-b', email: email.toUpperCase() }
      ])
    ).toEqual([`${email} (account-a)`, `${email.toUpperCase()} (account-b)`])
  })

  it('keeps unambiguous accounts concise', () => {
    expect(labels([{ id: 'account-a', email }])).toEqual([email])
    expect(labels([{ id: 'account-a', email, workspaceLabel: 'Acme' }])).toEqual([
      `${email} (Acme)`
    ])
  })

  it('does not collide with a workspace name that looks like an ID suffix', () => {
    const result = labels([
      { id: '12345678-a', email },
      { id: '87654321-b', email },
      { id: 'abcdefgh-c', email, workspaceLabel: '12345678' }
    ])
    expect(new Set(result).size).toBe(3)
  })
})
