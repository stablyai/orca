import { describe, expect, it } from 'vitest'

import { buildLinearIssueLinkUpdates, parseLinearIssueInput } from './links'

describe('linear links', () => {
  it('parses Linear team keys that start with a digit', () => {
    for (const identifier of ['2eng-123', '1pass-42', '3d-15', '4k-12']) {
      expect(parseLinearIssueInput(`  ${identifier}  `)).toEqual({
        identifier: identifier.toUpperCase()
      })
      expect(parseLinearIssueInput(`https://linear.app/acme/issue/${identifier}/notes`)).toEqual({
        identifier: identifier.toUpperCase(),
        organizationUrlKey: 'acme'
      })
    }
  })

  it('rejects numeric-only team keys in bare identifiers and URLs', () => {
    for (const identifier of [
      '2026-09',
      '555-1234',
      '8080-8090',
      '123-456',
      '1-1',
      '007-42',
      '1_2-3',
      '1-800'
    ]) {
      expect(parseLinearIssueInput(identifier)).toBeNull()
      expect(parseLinearIssueInput(`https://linear.app/acme/issue/${identifier}/notes`)).toBeNull()
    }
  })

  it('rejects non-Linear issue input', () => {
    expect(parseLinearIssueInput('https://example.com/acme/issue/ENG-123')).toBeNull()
    expect(parseLinearIssueInput('not an issue')).toBeNull()
  })

  // These later reach shell.openUrl; host-only validation would accept unsafe protocols.
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

  // Stale org keys can resolve/persist a new issue into the previous issue’s workspace.
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
})
