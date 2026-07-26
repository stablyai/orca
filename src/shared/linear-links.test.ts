import { describe, expect, it } from 'vitest'

import {
  buildLinearPersonalApiKeySettingsUrl,
  buildLinearTeamUrl,
  buildLinearWorkspaceApiSettingsUrl,
  getLinearOrganizationUrlKeyFromIssueUrl,
  isLinearIssueIdentifier,
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
    expect(parseLinearIssueInput('2eng-123')).toEqual({ identifier: '2ENG-123' })
    expect(parseLinearIssueInput('1pass-42')).toEqual({ identifier: '1PASS-42' })
    expect(parseLinearIssueInput('3d-15')).toEqual({ identifier: '3D-15' })
  })

  it('rejects all-numeric team keys that look like dates, phone numbers, or ranges', () => {
    for (const input of [
      '2026-07',
      '555-1234',
      '8080-8090',
      '123-456',
      '1-1',
      '007-42',
      '1_2-3',
      '1-800'
    ]) {
      expect(parseLinearIssueInput(input)).toBeNull()
    }
    expect(parseLinearIssueInput('https://linear.app/acme/issue/2026-07/notes')).toBeNull()
  })

  it('parses Linear issue URLs with organization URL keys', () => {
    expect(parseLinearIssueInput('https://linear.app/acme/issue/eng-123/fix-auth')).toEqual({
      identifier: 'ENG-123',
      organizationUrlKey: 'acme'
    })
    expect(parseLinearIssueInput('https://linear.app/acme/issue/2eng-123/fix-auth')).toEqual({
      identifier: '2ENG-123',
      organizationUrlKey: 'acme'
    })
    expect(parseLinearIssueInput('https://linear.app/stably/issue/STA-335/test-issue')).toEqual({
      identifier: 'STA-335',
      organizationUrlKey: 'stably'
    })
  })

  it('recognizes bare identifiers without parsing them', () => {
    expect(isLinearIssueIdentifier('  eng-123  ')).toBe(true)
    expect(isLinearIssueIdentifier('2ENG-1')).toBe(true)
    expect(isLinearIssueIdentifier('2026-07')).toBe(false)
    expect(isLinearIssueIdentifier('https://linear.app/acme/issue/ENG-1')).toBe(false)
  })

  it('rejects non-Linear issue input', () => {
    expect(parseLinearIssueInput('https://example.com/acme/issue/ENG-123')).toBeNull()
    expect(parseLinearIssueInput('not an issue')).toBeNull()
  })
})
