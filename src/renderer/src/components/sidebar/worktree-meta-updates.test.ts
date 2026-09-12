import { describe, expect, it } from 'vitest'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import {
  buildWorktreeMetaUpdates,
  parseGitLabMergeRequestNumberForMetaField,
  type WorktreeMetaDraft,
  type WorktreeMetaLiveLinks,
  type WorktreeMetaSnapshot,
  type WorktreeReviewProvider
} from './worktree-meta-updates'

function makeDraft(overrides: Partial<WorktreeMetaDraft> = {}): WorktreeMetaDraft {
  return {
    displayNameInput: 'Workspace',
    issueInput: '',
    issueProvider: 'github',
    reviewInput: '',
    commentInput: '',
    ...overrides
  }
}

function makeSnapshot(overrides: Partial<WorktreeMetaSnapshot> = {}): WorktreeMetaSnapshot {
  return {
    displayName: 'Workspace',
    comment: '',
    issueInput: '',
    issueProvider: 'github',
    prInput: '',
    ...overrides
  }
}

/** Persistence raw-spreads updates, so a present-but-undefined key erases the
 *  stored value — the invariant is asserted on every build in this suite. */
function buildUpdates(
  draft: Partial<WorktreeMetaDraft>,
  snapshot: Partial<WorktreeMetaSnapshot> = {},
  live: WorktreeMetaLiveLinks = {},
  reviewProvider: WorktreeReviewProvider = 'github'
): Partial<WorktreeMeta> {
  const updates = buildWorktreeMetaUpdates(
    makeDraft(draft),
    makeSnapshot(snapshot),
    live,
    reviewProvider
  )
  const undefinedKeys = Object.keys(updates).filter(
    (key) => updates[key as keyof WorktreeMeta] === undefined
  )
  expect(undefinedKeys).toEqual([])
  return updates
}

const LINEAR_LINK_KEYS = [
  'linkedLinearIssue',
  'linkedLinearIssueWorkspaceId',
  'linkedLinearIssueOrganizationUrlKey'
] as const

describe('buildWorktreeMetaUpdates', () => {
  it('writes only the GitLab MR slot in GitLab mode', () => {
    expect(buildUpdates({ reviewInput: '!42' }, {}, {}, 'gitlab')).toEqual({
      linkedGitLabMR: 42
    })
    expect(buildUpdates({ reviewInput: '' }, {}, {}, 'gitlab')).toEqual({ linkedGitLabMR: null })
  })

  it('accepts only positive MR references for the GitLab review row', () => {
    expect(parseGitLabMergeRequestNumberForMetaField('42')).toBe(42)
    expect(parseGitLabMergeRequestNumberForMetaField('!42')).toBe(42)
    expect(
      parseGitLabMergeRequestNumberForMetaField(
        'https://gitlab.example.com/group/project/-/merge_requests/42'
      )
    ).toBe(42)
    for (const invalid of [
      '#42',
      '0',
      '!0',
      '9007199254740992',
      'https://gitlab.example.com/group/project/-/issues/42',
      'https://gitlab.example.com/group/project/-/work_items/42',
      'ftp://gitlab.example.com/group/project/-/merge_requests/42'
    ]) {
      expect(parseGitLabMergeRequestNumberForMetaField(invalid)).toBeNull()
    }
  })
  // The dialog opens focused on Comment, so this is the common save path; a
  // regression here silently destroys the user's existing link.
  it('emits no link keys when the issue field is untouched', () => {
    const updates = buildUpdates(
      { issueInput: 'STA-335', issueProvider: 'linear', commentInput: 'shipping today' },
      { issueInput: 'STA-335', issueProvider: 'linear' }
    )

    expect(updates.comment).toBe('shipping today')
    expect(updates).not.toHaveProperty('linkedPR')
    expect(updates).not.toHaveProperty('linkedIssue')
    for (const key of LINEAR_LINK_KEYS) {
      expect(updates).not.toHaveProperty(key)
    }
  })

  it('writes a GitHub issue number and clears the Linear slots', () => {
    expect(buildUpdates({ issueInput: '12' }, {}, { linkedLinearIssue: 'STA-335' })).toEqual({
      linkedIssue: 12,
      linkedLinearIssue: null,
      linkedLinearIssueWorkspaceId: null,
      linkedLinearIssueOrganizationUrlKey: null
    })
  })

  // Persistence gates the remote Linear capability on key presence, so a clear
  // for a link that never existed fails a GitHub-only save on an older runtime.
  it('emits no Linear clear when the workspace holds no Linear link', () => {
    const updates = buildUpdates({ issueInput: '12' })

    expect(updates).toEqual({ linkedIssue: 12 })
    for (const key of LINEAR_LINK_KEYS) {
      expect(updates).not.toHaveProperty(key)
    }
  })

  it('writes a bare Linear identifier and clears the stored organization key', () => {
    expect(buildUpdates({ issueInput: 'sta-335', issueProvider: 'linear' })).toEqual({
      linkedIssue: null,
      linkedLinearIssue: 'STA-335',
      linkedLinearIssueWorkspaceId: null,
      linkedLinearIssueOrganizationUrlKey: null
    })
  })

  it('takes the organization key from a Linear issue URL', () => {
    expect(
      buildUpdates({
        issueInput: 'https://linear.app/acme/issue/STA-335/fix-auth',
        issueProvider: 'linear'
      })
    ).toEqual({
      linkedIssue: null,
      linkedLinearIssue: 'STA-335',
      linkedLinearIssueWorkspaceId: null,
      linkedLinearIssueOrganizationUrlKey: 'acme'
    })
  })

  it('clears every provider slot when the issue field is emptied', () => {
    expect(
      buildUpdates(
        { issueInput: '  ' },
        { issueInput: '42' },
        { linkedIssue: 42, linkedLinearIssue: 'STA-335' }
      )
    ).toEqual({
      linkedIssue: null,
      linkedLinearIssue: null,
      linkedLinearIssueWorkspaceId: null,
      linkedLinearIssueOrganizationUrlKey: null
    })
  })

  it('treats a provider switch with unchanged text as dirty', () => {
    const updates = buildUpdates(
      { issueInput: 'STA-335', issueProvider: 'linear' },
      { issueInput: 'STA-335', issueProvider: 'github' }
    )

    expect(updates.linkedLinearIssue).toBe('STA-335')
    expect(updates.linkedIssue).toBeNull()
  })

  it('displaces a Linear linked work item when the issue field changes', () => {
    const updates = buildUpdates(
      { issueInput: '12' },
      {},
      {
        linkedLinearIssue: 'STA-335',
        linkedWorkItemProvider: 'linear',
        linkedWorkItemType: 'issue'
      }
    )

    expect(updates).toHaveProperty('linkedWorkItem', null)
    expect(updates).toHaveProperty('linkedTaskSourceContext', null)
  })

  // linkedWorkItem also records the PR or MR a workspace was created from, which
  // the Issue row does not own and must not drop.
  it('leaves a PR-typed work item alone', () => {
    const updates = buildUpdates(
      { issueInput: '12' },
      {},
      { linkedWorkItemProvider: 'github', linkedWorkItemType: 'pr' }
    )

    expect(updates).not.toHaveProperty('linkedWorkItem')
    expect(updates).not.toHaveProperty('linkedTaskSourceContext')
  })

  // The row cannot render a GitLab or Jira issue, so clearing one would destroy a
  // link the user was never shown — and neither has another editor to restore it.
  it('leaves work items owned by other providers alone', () => {
    for (const provider of ['jira', 'gitlab'] as const) {
      const updates = buildUpdates(
        { issueInput: '12' },
        {},
        { linkedWorkItemProvider: provider, linkedWorkItemType: 'issue' }
      )

      expect(updates).not.toHaveProperty('linkedWorkItem')
      expect(updates).not.toHaveProperty('linkedTaskSourceContext')
    }
  })

  // Only the spelling changed, so the field names the same issue it already
  // holds — treating that as an edit would clear the title and source context.
  it('emits nothing when a GitHub number is respelled with a hash', () => {
    const updates = buildUpdates(
      { issueInput: '#42' },
      { issueInput: '42' },
      { linkedIssue: 42, linkedWorkItemProvider: 'github', linkedWorkItemType: 'issue' }
    )

    expect(updates).toEqual({})
  })

  it('emits nothing when a Linear identifier is respelled in lower case', () => {
    const updates = buildUpdates(
      { issueInput: 'sta-335', issueProvider: 'linear' },
      { issueInput: 'STA-335', issueProvider: 'linear' },
      { linkedLinearIssue: 'STA-335' }
    )

    expect(updates).toEqual({})
  })

  it('emits nothing when a Linear identifier is respelled as its stored URL', () => {
    const updates = buildUpdates(
      { issueInput: 'https://linear.app/acme/issue/STA-335/fix-auth', issueProvider: 'linear' },
      {
        issueInput: 'STA-335',
        issueProvider: 'linear',
        linkedLinearIssueOrganizationUrlKey: 'acme'
      },
      { linkedLinearIssue: 'STA-335' }
    )

    expect(updates).toEqual({})
  })

  // The URL adds the org key the stored link lacked, which is worth persisting —
  // but it still names the same issue, so its title and routing context stay.
  it('records an organization key for a stored bare identifier without displacing it', () => {
    const updates = buildUpdates(
      { issueInput: 'https://linear.app/acme/issue/STA-335', issueProvider: 'linear' },
      { issueInput: 'STA-335', issueProvider: 'linear' },
      {
        linkedLinearIssue: 'STA-335',
        linkedWorkItemProvider: 'linear',
        linkedWorkItemType: 'issue'
      }
    )

    expect(updates.linkedLinearIssueOrganizationUrlKey).toBe('acme')
    expect(updates).not.toHaveProperty('linkedWorkItem')
    expect(updates).not.toHaveProperty('linkedTaskSourceContext')
  })

  // Same identifier, different organization: a team-prefix collision across two
  // Linear workspaces is a different issue, so the stale title has to go.
  it('displaces the work item when a URL names another organization', () => {
    const updates = buildUpdates(
      { issueInput: 'https://linear.app/other/issue/STA-335', issueProvider: 'linear' },
      {
        issueInput: 'STA-335',
        issueProvider: 'linear',
        linkedLinearIssueOrganizationUrlKey: 'acme'
      },
      {
        linkedLinearIssue: 'STA-335',
        linkedLinearIssueOrganizationUrlKey: 'acme',
        linkedWorkItemProvider: 'linear',
        linkedWorkItemType: 'issue'
      }
    )

    expect(updates.linkedLinearIssueOrganizationUrlKey).toBe('other')
    expect(updates).toHaveProperty('linkedWorkItem', null)
    expect(updates).toHaveProperty('linkedTaskSourceContext', null)
  })

  // A CLI or background write can land while the dialog is open. Displacement
  // reads live state, so the save cannot leave both provider slots populated.
  it('clears a Linear link added after the snapshot was taken', () => {
    const updates = buildUpdates({ issueInput: '12' }, {}, { linkedLinearIssue: 'STA-999' })

    expect(updates.linkedIssue).toBe(12)
    expect(updates.linkedLinearIssue).toBeNull()
  })

  it('clears a Linear link added after the snapshot when the field is emptied', () => {
    const updates = buildUpdates(
      { issueInput: '' },
      { issueInput: '42' },
      { linkedLinearIssue: 'STA-999' }
    )

    expect(updates.linkedIssue).toBeNull()
    expect(updates.linkedLinearIssue).toBeNull()
  })

  it('ignores a provider switch on an empty field', () => {
    const updates = buildUpdates(
      { issueInput: '', issueProvider: 'linear' },
      { issueInput: '', issueProvider: 'github' }
    )

    expect(updates).not.toHaveProperty('linkedIssue')
    for (const key of LINEAR_LINK_KEYS) {
      expect(updates).not.toHaveProperty(key)
    }
  })

  it('does not displace a Linear work item when the issue field is clean', () => {
    const updates = buildUpdates({ commentInput: 'note' }, {}, { linkedWorkItemProvider: 'linear' })

    expect(updates).not.toHaveProperty('linkedWorkItem')
    expect(updates).not.toHaveProperty('linkedTaskSourceContext')
  })

  it('leaves links untouched for unparseable issue input', () => {
    const updates = buildUpdates(
      { issueInput: 'not an issue', displayNameInput: 'Renamed', commentInput: 'note' },
      { displayName: 'Workspace' }
    )

    expect(updates).toEqual({
      comment: 'note',
      displayName: 'Renamed'
    })
  })

  it('clears a display name with empty string, never a present-undefined key', () => {
    const updates = buildUpdates({ displayNameInput: '   ' }, { displayName: 'Custom Name' })

    expect(updates.displayName).toBe('')
  })

  it('rejects issue URLs in the PR input', () => {
    expect(buildUpdates({ reviewInput: 'https://github.com/stablyai/orca/issues/6933' })).toEqual(
      {}
    )
  })

  it('accepts PR URLs in the PR input', () => {
    expect(buildUpdates({ reviewInput: 'https://github.com/stablyai/orca/pull/6934' })).toEqual({
      linkedPR: 6934
    })
  })

  it('records suppression when the user clears an explicit PR link', () => {
    expect(buildUpdates({ reviewInput: '' }, { prInput: '6934' }, { linkedPR: 6934 })).toEqual({
      linkedPR: null,
      suppressedGitHubPR: 6934
    })
  })

  it('does not invent suppression for an already-unlinked PR field', () => {
    expect(buildUpdates({ reviewInput: '' }, {}, { linkedPR: null })).toEqual({})
  })

  it('does not suppress a PR linked in the background when the PR field is untouched', () => {
    expect(buildUpdates({ commentInput: 'note' }, {}, { linkedPR: 6934 })).toEqual({
      comment: 'note'
    })
  })

  it('accepts issue URLs in the issue input', () => {
    expect(
      buildUpdates(
        { issueInput: 'https://github.com/stablyai/orca/issues/6933' },
        {},
        { linkedLinearIssue: 'STA-335' }
      )
    ).toEqual({
      linkedIssue: 6933,
      linkedLinearIssue: null,
      linkedLinearIssueWorkspaceId: null,
      linkedLinearIssueOrganizationUrlKey: null
    })
  })

  it('rejects PR URLs in the issue input', () => {
    expect(buildUpdates({ issueInput: 'https://github.com/stablyai/orca/pull/6934' })).toEqual({})
  })

  // Persistence stamps lastActivityAt on any comment write, so re-emitting an
  // unchanged note reorders the workspace under the time-decay sidebar sort.
  it('emits no comment when the note is unchanged', () => {
    const updates = buildUpdates(
      { issueInput: '12', commentInput: 'shipping today' },
      { comment: 'shipping today' }
    )

    expect(updates).not.toHaveProperty('comment')
    expect(updates.linkedIssue).toBe(12)
  })

  it('clears a comment with empty string, never a present-undefined key', () => {
    expect(buildUpdates({ commentInput: '  ' }, { comment: 'old note' }).comment).toBe('')
  })
})
