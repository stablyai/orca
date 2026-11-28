import { describe, expect, it } from 'vitest'
import type {
  ClaudeManagedAccountSummary,
  ClaudeRateLimitAccountsState
} from '../../../../../shared/agent-accounts/managed-account-types'
import {
  buildClaudeStatusSwitchGroups,
  signedInClaudeAccountCount
} from './status-bar-claude-accounts'

const ORG = 'org-eng'
const HOST = { runtime: 'host', wslDistro: null } as const

function account(
  id: string,
  email: string,
  extra: Partial<ClaudeManagedAccountSummary> = {}
): ClaudeManagedAccountSummary {
  return {
    id,
    email,
    organizationUuid: `${ORG}-${email}`,
    managedAuthRuntime: 'host',
    wslDistro: null,
    authMethod: 'subscription-oauth',
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1,
    ...extra
  }
}

// Same identity (email + org + host scope) saved as three records, as on the reporter's machine.
function rosterWithDuplicates(activeId: string): ClaudeRateLimitAccountsState {
  const eng = { organizationUuid: ORG }
  return {
    accounts: [
      account('own-login', 'eng@example.com', { ...eng, updatedAt: 30 }),
      account('borrowed', 'eng@example.com', { ...eng, runsOnSystemDefault: true, updatedAt: 10 }),
      account('resigned', 'ENG@example.com', { ...eng, updatedAt: 40 }),
      account('other', 'other@example.com', { updatedAt: 20 }),
      account('gone', 'gone@example.com', { needsSignIn: true, updatedAt: 5 })
    ],
    activeAccountId: activeId,
    activeAccountIdsByRuntime: { host: activeId, wsl: {} },
    systemDefaultEmail: 'eng@example.com',
    systemDefaultOrganizationUuid: ORG
  }
}

function hostRows(state: ClaudeRateLimitAccountsState) {
  return buildClaudeStatusSwitchGroups(state, HOST)[0].targets.filter((t) => t.id !== null)
}

describe('Claude status switcher identities', () => {
  it('shows one row per account even when several records hold the same login', () => {
    const rows = hostRows(rosterWithDuplicates('borrowed'))
    const engRows = rows.filter((row) => row.label.toLowerCase() === 'eng@example.com')
    expect(engRows).toHaveLength(1)
    // The selected record stays the row, so the panel's sign-in state describes what launches use.
    expect(engRows[0]).toMatchObject({ id: 'borrowed', active: true })
    expect(rows.map((row) => row.id)).toEqual(['borrowed', 'other', 'gone'])
  })

  it('represents an unselected duplicated account by its own signed-in record', () => {
    const rows = hostRows(rosterWithDuplicates('other'))
    const engRows = rows.filter((row) => row.label.toLowerCase() === 'eng@example.com')
    expect(engRows).toEqual([expect.objectContaining({ id: 'resigned', active: false })])
  })

  it('hides a signed-out record whose account is signed in through another record', () => {
    const state = rosterWithDuplicates('other')
    state.accounts.push(
      account('stale', 'eng@example.com', { organizationUuid: ORG, needsSignIn: true })
    )
    const rows = hostRows(state)
    expect(rows.find((row) => row.id === 'stale')).toBeUndefined()
    expect(rows.find((row) => row.id === 'gone')).toMatchObject({ needsSignIn: true })
  })

  it('keeps same-email accounts in different organizations apart', () => {
    const state = rosterWithDuplicates('other')
    state.accounts.push(account('team', 'eng@example.com', { organizationUuid: 'org-team' }))
    expect(
      hostRows(state).filter((row) => row.label.toLowerCase() === 'eng@example.com')
    ).toHaveLength(2)
  })

  it('counts signed-in accounts, not saved records', () => {
    // eng (3 records + System default) and other; gone is signed out.
    expect(signedInClaudeAccountCount(rosterWithDuplicates('other'))).toBe(2)
  })
  it('preserves selected sign-out state while attributing usage to the usable identity record', () => {
    const state = rosterWithDuplicates('stale')
    state.accounts.push(
      account('stale', 'eng@example.com', { organizationUuid: ORG, needsSignIn: true })
    )
    expect(hostRows(state).filter((row) => row.label.toLowerCase() === 'eng@example.com')).toEqual([
      expect.objectContaining({
        id: 'stale',
        active: true,
        needsSignIn: true,
        usageAccountId: 'resigned',
        usableAccountId: 'resigned'
      })
    ])
  })

  it('keeps host and WSL identities separate and preserves system-default metadata', () => {
    const state = rosterWithDuplicates('other')
    state.accounts.push(
      account('ubuntu', 'eng@example.com', {
        organizationUuid: ORG,
        managedAuthRuntime: 'wsl',
        wslDistro: 'Ubuntu'
      })
    )
    const groups = buildClaudeStatusSwitchGroups(state, HOST)
    expect(groups[1].targets.find((row) => row.id === 'ubuntu')).toMatchObject({
      runtimeTarget: { runtime: 'wsl', wslDistro: 'Ubuntu' }
    })
    expect(signedInClaudeAccountCount(state)).toBe(2)
  })
  it('deduplicates historical WSL casing aliases while retaining selected and usage records', () => {
    const state: ClaudeRateLimitAccountsState = {
      accounts: [
        account('selected', 'eng@example.com', {
          organizationUuid: ORG,
          managedAuthRuntime: 'wsl',
          wslDistro: 'Ubuntu',
          needsSignIn: true
        }),
        account('usable', 'eng@example.com', {
          organizationUuid: ORG,
          managedAuthRuntime: 'wsl',
          wslDistro: 'ubuntu'
        })
      ],
      activeAccountId: null,
      activeAccountIdsByRuntime: { host: null, wsl: { ubuntu: 'selected' } }
    }
    const groups = buildClaudeStatusSwitchGroups(state, { runtime: 'wsl', wslDistro: 'Ubuntu' })
    expect(groups).toHaveLength(2)
    expect(groups[1].targets.filter((row) => row.id)).toEqual([
      expect.objectContaining({
        id: 'selected',
        active: true,
        needsSignIn: true,
        usageAccountId: 'usable'
      })
    ])
  })
  it.each([
    ['Ubuntu', 'a'],
    ['ubuntu', 'b']
  ])('uses the exact selected record for conflicting historical lane %s', (distro, selectedId) => {
    const state: ClaudeRateLimitAccountsState = {
      accounts: [
        account('a', 'eng@example.com', {
          organizationUuid: ORG,
          managedAuthRuntime: 'wsl',
          wslDistro: 'Ubuntu'
        }),
        account('b', 'eng@example.com', {
          organizationUuid: ORG,
          managedAuthRuntime: 'wsl',
          wslDistro: 'ubuntu'
        })
      ],
      activeAccountId: null,
      activeAccountIdsByRuntime: { host: null, wsl: { Ubuntu: 'a', ubuntu: 'b' } }
    }
    const group = buildClaudeStatusSwitchGroups(state, { runtime: 'wsl', wslDistro: distro })[1]
    expect(group.targets.find((row) => row.active)?.id).toBe(selectedId)
    expect(group.targets.find((row) => row.id === null)?.active).toBe(false)
    expect(group.runtimeTarget.wslDistro).toBe(distro)
  })
  it('keeps an ambiguous lane distinct from default, then recognizes an explicit clear', () => {
    const state: ClaudeRateLimitAccountsState = {
      accounts: [],
      activeAccountId: null,
      activeAccountIdsByRuntime: { host: null, wsl: { Ubuntu: 'a', ubuntu: 'b' } }
    }
    const target = { runtime: 'wsl' as const, wslDistro: 'uBuNtU' }
    expect(
      buildClaudeStatusSwitchGroups(state, target)[1].targets.find((row) => row.id === null)?.active
    ).toBe(false)
    state.activeAccountIdsByRuntime = { host: null, wsl: { Ubuntu: null, ubuntu: null } }
    expect(
      buildClaudeStatusSwitchGroups(state, target)[1].targets.find((row) => row.id === null)?.active
    ).toBe(true)
  })
})
