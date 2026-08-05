import { describe, expect, it } from 'vitest'

import {
  buildLinearIssueLinkUpdates,
  buildLinearIssueUrl,
  buildLinearPersonalApiKeySettingsUrl,
  buildLinearTeamUrl,
  buildLinearWorkspaceApiSettingsUrl,
  getLinearOrganizationUrlKeyFromIssueUrl,
  parseLinearIssueInput
} from './linear-links'

describe('linear links', () => {
  it('builds team URLs from workspace and team keys', () => {
    expect(buildLinearTeamUrl({ organizationUrlKey: 'acme', teamKey: 'ENG' })).toBe(
      'https://linear.app/acme/team/ENG/all'
    )
  })

  it('encodes URL path segments', () => {
    expect(buildLinearTeamUrl({ organizationUrlKey: 'acme inc', teamKey: 'A/B' })).toBe(
      'https://linear.app/acme%20inc/team/A%2FB/all'
    )
  })

  it('extracts the workspace URL key from Linear issue URLs', () => {
    expect(getLinearOrganizationUrlKeyFromIssueUrl('https://linear.app/acme/issue/ENG-1')).toBe(
      'acme'
    )
  })

  it('builds organization-scoped API key settings URLs', () => {
    expect(buildLinearPersonalApiKeySettingsUrl('acme inc')).toBe(
      'https://linear.app/acme%20inc/settings/account/security'
    )
    expect(buildLinearWorkspaceApiSettingsUrl('acme/inc')).toBe(
      'https://linear.app/acme%2Finc/settings/api'
    )
  })

  it('falls back to global API settings URLs when no organization slug is available', () => {
    expect(buildLinearPersonalApiKeySettingsUrl()).toBe(
      'https://linear.app/settings/account/security'
    )
    expect(buildLinearWorkspaceApiSettingsUrl('   ')).toBe('https://linear.app/settings/api')
  })

  it('parses bare Linear issue identifiers', () => {
    expect(parseLinearIssueInput('eng-123')).toEqual({ identifier: 'ENG-123' })
  })

  it('parses Linear issue URLs with organization URL keys', () => {
    expect(parseLinearIssueInput('https://linear.app/acme/issue/eng-123/fix-auth')).toEqual({
      identifier: 'ENG-123',
      organizationUrlKey: 'acme'
    })
    expect(parseLinearIssueInput('https://linear.app/stably/issue/STA-335/test-issue')).toEqual({
      identifier: 'STA-335',
      organizationUrlKey: 'stably'
    })
  })

  it('rejects non-Linear issue input', () => {
    expect(parseLinearIssueInput('https://example.com/acme/issue/ENG-123')).toBeNull()
    expect(parseLinearIssueInput('not an issue')).toBeNull()
  })

  // A hostname-only check accepts these, and the parsed link is later handed to
  // shell.openUrl — so the protocol gate is load-bearing, not cosmetic.
  it('rejects linear.app URLs on non-web protocols', () => {
    for (const input of [
      'file://linear.app/acme/issue/ENG-123',
      'javascript://linear.app/acme/issue/ENG-123',
      'ftp://linear.app/acme/issue/ENG-123'
    ]) {
      expect(parseLinearIssueInput(input)).toBeNull()
    }
  })
})

describe('buildLinearIssueUrl', () => {
  it('builds issue URLs from an identifier and organization key', () => {
    expect(buildLinearIssueUrl({ identifier: 'STA-335', organizationUrlKey: 'acme' })).toBe(
      'https://linear.app/acme/issue/STA-335'
    )
  })

  it('returns null when either part is missing or blank', () => {
    expect(buildLinearIssueUrl({ identifier: 'STA-335' })).toBeNull()
    expect(buildLinearIssueUrl({ organizationUrlKey: 'acme' })).toBeNull()
    expect(buildLinearIssueUrl({ identifier: '  ', organizationUrlKey: 'acme' })).toBeNull()
    expect(buildLinearIssueUrl({ identifier: 'STA-335', organizationUrlKey: null })).toBeNull()
  })

  it('encodes URL-unsafe path segments', () => {
    expect(buildLinearIssueUrl({ identifier: 'A/B-1', organizationUrlKey: 'acme inc' })).toBe(
      'https://linear.app/acme%20inc/issue/A%2FB-1'
    )
  })
})

describe('buildLinearIssueLinkUpdates', () => {
  function expectNoUndefinedValues(updates: Record<string, unknown>): void {
    expect(Object.keys(updates).filter((key) => updates[key] === undefined)).toEqual([])
  }

  it('clears every link field for empty input', () => {
    for (const input of ['', '   ']) {
      const result = buildLinearIssueLinkUpdates(input)
      expect(result).toEqual({
        linkedLinearIssue: null,
        linkedLinearIssueWorkspaceId: null,
        linkedLinearIssueOrganizationUrlKey: null
      })
    }
  })

  // Inheriting the previous issue's org key would let resolveLegacyLinearLinkWorkspace
  // match it and persist a workspace id the new issue does not belong to.
  it('clears the organization key for bare identifiers', () => {
    const result = buildLinearIssueLinkUpdates('STA-335')

    expect(result).toEqual({
      linkedLinearIssue: 'STA-335',
      linkedLinearIssueWorkspaceId: null,
      linkedLinearIssueOrganizationUrlKey: null
    })
    expectNoUndefinedValues(result as Record<string, unknown>)
  })

  it('takes the organization key from a Linear issue URL', () => {
    const result = buildLinearIssueLinkUpdates('https://linear.app/acme/issue/sta-335/fix-auth')

    expect(result).toEqual({
      linkedLinearIssue: 'STA-335',
      linkedLinearIssueWorkspaceId: null,
      linkedLinearIssueOrganizationUrlKey: 'acme'
    })
    expectNoUndefinedValues(result as Record<string, unknown>)
  })

  it('returns null for unparseable input', () => {
    expect(buildLinearIssueLinkUpdates('not an issue')).toBeNull()
    expect(buildLinearIssueLinkUpdates('https://github.com/o/r/issues/12')).toBeNull()
  })
})
