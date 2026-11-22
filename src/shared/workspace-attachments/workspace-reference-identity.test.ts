import { describe, expect, it } from 'vitest'
import { WorkspaceAttachmentSchema } from './workspace-attachment-schema'
import { normalizeWorkspaceAttachments } from './workspace-attachment-normalization'
import {
  matchesWorkspaceReferenceQuery,
  parseWorkspaceReferenceQuery,
  parseWorkspaceReferenceUrl
} from './workspace-reference-identity'

describe('plain link references', () => {
  it('keeps an unknown tracker URL as a link, but not a forge route it cannot name', () => {
    const url = 'https://bugs.example.org/show_bug.cgi?id=42#c3'
    const stored = WorkspaceAttachmentSchema.parse(parseWorkspaceReferenceUrl(url))

    expect(stored).toEqual({
      provider: 'link',
      type: 'issue',
      number: 0,
      url: 'https://bugs.example.org/show_bug.cgi?id=42'
    })
    expect(matchesWorkspaceReferenceQuery(stored, parseWorkspaceReferenceQuery(url))).toBe(true)
    const otherUrl = 'https://bugs.example.org/show_bug.cgi?id=43'
    const other = parseWorkspaceReferenceUrl(otherUrl)
    expect(matchesWorkspaceReferenceQuery(stored, parseWorkspaceReferenceQuery(otherUrl))).toBe(
      false
    )
    expect(normalizeWorkspaceAttachments([stored, other])).toHaveLength(2)
    // GitHub Enterprise and Gitea share this route, so removal by URL must keep matching either.
    expect(() => parseWorkspaceReferenceUrl('https://git.example.org/acme/api/issues/42')).toThrow(
      'Unsupported reference URL'
    )
  })
})
