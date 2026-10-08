import { describe, expect, it } from 'vitest'
import {
  getSmartWorkspaceLinearSearchQuery,
  parseBoundedSmartWorkspaceLinearIssueInput,
  parseBoundedSmartWorkspaceLinearIssueUrlIntent
} from './smart-workspace-linear-intent'

describe('numeric-leading Linear workspace source input', () => {
  it.each(['2eng-123', '1pass-42', '3d-15'])('recognizes %s as an issue identifier', (input) => {
    const identifier = input.toUpperCase()
    const url = `https://linear.app/acme/issue/${input}/notes`
    const intent = { identifier, organizationUrlKey: 'acme' }

    expect(parseBoundedSmartWorkspaceLinearIssueInput(`  ${input}  `)).toEqual({ identifier })
    expect(getSmartWorkspaceLinearSearchQuery(input)).toBe(identifier)
    expect(parseBoundedSmartWorkspaceLinearIssueInput(url)).toEqual(intent)
    expect(parseBoundedSmartWorkspaceLinearIssueUrlIntent(url)).toEqual(intent)
    expect(getSmartWorkspaceLinearSearchQuery(url)).toBe(identifier)
  })

  it.each(['2026-09', '555-1234', '8080-8090', '1_2-3'])(
    'keeps %s as search text without issue intent',
    (input) => {
      const url = `https://linear.app/acme/issue/${input}/notes`

      expect(parseBoundedSmartWorkspaceLinearIssueInput(input)).toBeNull()
      expect(getSmartWorkspaceLinearSearchQuery(input)).toBe(input)
      expect(parseBoundedSmartWorkspaceLinearIssueInput(url)).toBeNull()
      expect(parseBoundedSmartWorkspaceLinearIssueUrlIntent(url)).toBeNull()
    }
  )
})
