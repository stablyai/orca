import { describe, expect, it } from 'vitest'
import { normalizeGitRemoteUrl } from '../git/remotes/git-remote-identity'
import { getWorkspaceAttachmentUrlScope } from './workspace-attachment-normalization'
import {
  getWorkspaceReferenceIdentity,
  parseWorkspaceReferenceUrl
} from './workspace-reference-identity'

const project = 'https://gitlab.example.com/group/sub/project'

describe('GitLab work item reference URLs', () => {
  it('scope work items to their own project like issues', () => {
    for (const url of [`${project}/-/work_items/1980`, `${project}/-/issues/1980`]) {
      const scope = getWorkspaceAttachmentUrlScope({
        provider: 'gitlab',
        type: 'issue',
        number: 1980,
        url
      })
      expect(normalizeGitRemoteUrl(scope)).toBe('gitlab.example.com/group/sub/project')
    }
    expect(
      getWorkspaceAttachmentUrlScope({
        provider: 'github',
        type: 'pr',
        number: 3,
        url: 'https://github.com/owner/work_items/pull/3'
      })
    ).toBe('https://github.com/owner/work_items')
  })

  it('parses work item URLs as GitLab issues', () => {
    expect(parseWorkspaceReferenceUrl(`${project}/-/work_items/1980/designs?x=1`)).toEqual({
      provider: 'gitlab',
      type: 'issue',
      number: 1980,
      url: `${project}/-/work_items/1980`
    })
  })

  it('treats issue and work item links for one iid as the same reference', () => {
    const workItem = parseWorkspaceReferenceUrl(`${project}/-/work_items/1980`)
    const issue = parseWorkspaceReferenceUrl(`${project}/-/issues/1980`)
    expect(getWorkspaceReferenceIdentity(workItem)).toBe(getWorkspaceReferenceIdentity(issue))
    expect(
      getWorkspaceReferenceIdentity(parseWorkspaceReferenceUrl(`${project}/-/merge_requests/1980`))
    ).not.toBe(getWorkspaceReferenceIdentity(issue))
  })
})
