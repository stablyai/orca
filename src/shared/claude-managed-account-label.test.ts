import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  getClaudeManagedAccountLabel,
  normalizeClaudeManagedAccountDisplayName,
  type ClaudeManagedAccountLabelSource
} from './claude-managed-account-label'

const email = 'me@example.com'

describe('getClaudeManagedAccountLabel', () => {
  it('uses a custom display name when set', () => {
    expect(
      getClaudeManagedAccountLabel({
        email,
        displayName: 'Work org',
        organizationName: 'Acme'
      })
    ).toBe('Work org (me@example.com)')
  })

  it('disambiguates duplicate emails with organization names', () => {
    const accounts: ClaudeManagedAccountLabelSource[] = [
      { email, organizationName: 'Work' },
      { email, organizationName: 'Personal' }
    ]
    const labels = accounts.map((account) => getClaudeManagedAccountLabel(account))
    expect(labels).toEqual(['me@example.com · Work', 'me@example.com · Personal'])
    expect(new Set(labels).size).toBe(2)
  })

  it('falls back to email when the organization name is empty', () => {
    expect(getClaudeManagedAccountLabel({ email, organizationName: null })).toBe(email)
    expect(getClaudeManagedAccountLabel({ email, organizationName: '   ' })).toBe(email)
    expect(getClaudeManagedAccountLabel({ email })).toBe(email)
  })

  it('treats a blank custom name as unset', () => {
    expect(
      getClaudeManagedAccountLabel({
        email,
        displayName: '   ',
        organizationName: 'Work'
      })
    ).toBe('me@example.com · Work')
  })

  it('fails if two same-email accounts still stringify to the same label', () => {
    const labels = [
      getClaudeManagedAccountLabel({ email, displayName: 'Work org' }),
      getClaudeManagedAccountLabel({ email, organizationName: 'Personal' })
    ]
    expect(new Set(labels).size).toBe(2)
  })
})

describe('normalizeClaudeManagedAccountDisplayName', () => {
  it('trims and clears blank names', () => {
    expect(normalizeClaudeManagedAccountDisplayName('  Work org  ')).toBe('Work org')
    expect(normalizeClaudeManagedAccountDisplayName('')).toBe(null)
    expect(normalizeClaudeManagedAccountDisplayName('   ')).toBe(null)
    expect(normalizeClaudeManagedAccountDisplayName(null)).toBe(null)
  })
})

describe('mobile accounts Claude label import', () => {
  it('reaches the repo-root helper from mobile/app/h/[hostId]', () => {
    const accountsPath = resolve(process.cwd(), 'mobile/app/h/[hostId]/accounts.tsx')
    const match = readFileSync(accountsPath, 'utf8').match(
      /from '((?:\.\.\/)+src\/shared\/claude-managed-account-label)'/
    )
    expect(match?.[1]).toBe('../../../../src/shared/claude-managed-account-label')
    expect(existsSync(resolve(dirname(accountsPath), `${match?.[1]}.ts`))).toBe(true)
  })
})
