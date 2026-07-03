import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getLinearIssueWorkspaceName,
  getLinkedWorkItemSuggestedName,
  getLinkedWorkItemWorkspaceName,
  getWorkspaceIntentName,
  resolveWorkspaceCreateName,
  slugifyForWorkspaceName
} from './workspace-name'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('slugifyForWorkspaceName', () => {
  it('keeps workspace seed slugs short, ascii-safe, and git-ref-safe', () => {
    expect(slugifyForWorkspaceName('../../Fix mobile Tasks 🚀')).toBe('fix-mobile-tasks')
    expect(slugifyForWorkspaceName('feature/add issue drawer')).toBe('feature-add-issue-drawer')
    expect(slugifyForWorkspaceName('a'.repeat(80))).toBe('a'.repeat(48))
  })

  it('removes apostrophes inside words instead of splitting them', () => {
    expect(slugifyForWorkspaceName("Can't enable browser notifications")).toBe(
      'cant-enable-browser-notifications'
    )
    expect(slugifyForWorkspaceName('Can’t enable browser notifications')).toBe(
      'cant-enable-browser-notifications'
    )
  })

  it('folds pasted workspace-name whitespace without regex replacement', () => {
    const replace = vi.spyOn(String.prototype, 'replace')
    const name = ['Fix', String.fromCharCode(160), '\nPasted\tWorkspace'].join('')

    expect(slugifyForWorkspaceName(name)).toBe('fix-pasted-workspace')
    expect(
      replace.mock.calls.filter(
        ([pattern]) => pattern instanceof RegExp && pattern.source === '\\s+'
      )
    ).toHaveLength(0)
  })
})

describe('getLinkedWorkItemSuggestedName', () => {
  it('removes duplicated issue and PR numbers from linked titles', () => {
    expect(getLinkedWorkItemSuggestedName({ title: 'Issue #123: Fix mobile Tasks' })).toBe(
      'fix-mobile-tasks'
    )
    expect(getLinkedWorkItemSuggestedName({ title: 'Add mobile drawer (#812)' })).toBe(
      'add-mobile-drawer'
    )
  })
})

describe('getLinkedWorkItemWorkspaceName', () => {
  it('uses the resolved GitHub title instead of the source URL or provider number', () => {
    expect(
      getLinkedWorkItemWorkspaceName({
        type: 'pr',
        number: 2049,
        title: 'Fix pasted URL workspace names'
      })
    ).toEqual({
      displayName: 'Fix pasted URL workspace names',
      seedName: 'fix-pasted-url-workspace-names'
    })
  })

  it('keeps external provider identifiers without duplicating title prefixes', () => {
    expect(
      getLinkedWorkItemWorkspaceName({
        type: 'issue',
        provider: 'jira',
        number: 0,
        title: 'PROJ-7 Fix flaky import',
        jiraIdentifier: 'PROJ-7'
      })
    ).toEqual({
      displayName: 'PROJ-7 Fix flaky import',
      seedName: 'proj-7-fix-flaky-import'
    })
  })
})

describe('getWorkspaceIntentName', () => {
  it('uses explicit user intent for linked issues without copying long titles', () => {
    expect(
      getWorkspaceIntentName({
        sourceText: 'https://github.com/mvanhorn/cli-printing-press/issues/2635 and fix it',
        workItem: {
          type: 'issue',
          number: 2635,
          title:
            "scorer/dogfood: live acceptance can't authenticate via the CLI's config/cookie credentials (scoped-home is env-only)"
        }
      })
    ).toEqual({
      displayName: 'Fix Issue 2635',
      seedName: 'fix-issue-2635'
    })
  })

  it('defaults PR and MR work to review-oriented identities', () => {
    expect(
      getWorkspaceIntentName({
        sourceText: 'https://github.com/acme/app/pull/1234 and check whether this is safe',
        workItem: {
          type: 'pr',
          number: 1234,
          title: 'Refactor account settings panel'
        }
      })
    ).toEqual({
      displayName: 'Review PR 1234',
      seedName: 'review-pr-1234'
    })
    expect(
      getWorkspaceIntentName({
        sourceText: 'fix https://gitlab.com/acme/app/-/merge_requests/77',
        workItem: {
          type: 'mr',
          provider: 'gitlab',
          number: 77,
          title: 'Resolve sync race'
        }
      })
    ).toEqual({
      displayName: 'Fix MR 77',
      seedName: 'fix-mr-77'
    })
  })

  it('uses a compressed subject when a linked issue has no action', () => {
    expect(
      getWorkspaceIntentName({
        sourceText: 'https://github.com/acme/app/issues/9876',
        workItem: {
          type: 'issue',
          number: 9876,
          title: 'Make importer handle archived rows'
        }
      })
    ).toEqual({
      displayName: 'Issue 9876 Make Importer Handle',
      seedName: 'issue-9876-make-importer-handle'
    })
  })

  it('keeps contractions readable in linked issue display names', () => {
    expect(
      getWorkspaceIntentName({
        sourceText: 'https://github.com/acme/app/issues/4802',
        workItem: {
          type: 'issue',
          number: 4802,
          title: "Can't enable browser notifications from within a browser tab"
        }
      })
    ).toEqual({
      displayName: "Issue 4802 Can't Enable Browser",
      seedName: 'issue-4802-cant-enable-browser'
    })
  })

  it('keeps single-letter contractions lowercase after the apostrophe', () => {
    expect(
      getWorkspaceIntentName({
        sourceText: 'https://github.com/acme/app/issues/17',
        workItem: {
          type: 'issue',
          number: 17,
          title: "i'm blocked on notifications"
        }
      })
    ).toEqual({
      displayName: "Issue 17 I'm Blocked Notifications",
      seedName: 'issue-17-im-blocked-notifications'
    })

    expect(
      getWorkspaceIntentName({
        sourceText: 'https://github.com/acme/app/issues/18',
        workItem: {
          type: 'issue',
          number: 18,
          title: "i'll update login"
        }
      })
    ).toEqual({
      displayName: "Issue 18 I'll Update Login",
      seedName: 'issue-18-ill-update-login'
    })
  })

  it('does not treat an auto-generated slug as explicit user intent', () => {
    expect(
      getWorkspaceIntentName({
        sourceText: 'issue-123-fix-navbar',
        workItem: {
          type: 'issue',
          number: 456,
          title: 'Make importer handle archived rows'
        }
      })
    ).toEqual({
      displayName: 'Issue 456 Make Importer Handle',
      seedName: 'issue-456-make-importer-handle'
    })
  })

  it('uses external provider identifiers without duplicating them in the subject', () => {
    expect(
      getWorkspaceIntentName({
        workItem: {
          type: 'issue',
          provider: 'jira',
          number: 0,
          title: 'PROJ-7 Fix flaky import',
          jiraIdentifier: 'PROJ-7'
        }
      })
    ).toEqual({
      displayName: 'PROJ-7 Fix Flaky Import',
      seedName: 'proj-7-fix-flaky-import'
    })
  })

  it('summarizes unlinked task text into a shared display and seed', () => {
    expect(getWorkspaceIntentName({ sourceText: 'add keyboard shortcut settings' })).toEqual({
      displayName: 'Add Keyboard Shortcut Settings',
      seedName: 'add-keyboard-shortcut-settings'
    })
  })

  it('compacts pasted task text without whitespace regex splitting', () => {
    const split = vi.spyOn(String.prototype, 'split')
    const sourceText = [
      'https://github.com/acme/app/issues/123',
      '\nadd',
      String.fromCharCode(160),
      'keyboard\tshortcut settings'
    ].join('')

    expect(getWorkspaceIntentName({ sourceText })).toEqual({
      displayName: 'Add Keyboard Shortcut Settings',
      seedName: 'add-keyboard-shortcut-settings'
    })
    expect(
      split.mock.calls.filter(([pattern]) => pattern instanceof RegExp && pattern.source === '\\s+')
    ).toHaveLength(0)
  })
})

describe('getLinearIssueWorkspaceName', () => {
  it('keeps the Linear identifier in the workspace seed', () => {
    expect(
      getLinearIssueWorkspaceName({
        identifier: 'ENG-42',
        title: 'Ship Linear parity'
      })
    ).toBe('eng-42-ship-linear-parity')
  })

  it('does not duplicate an identifier already present in the Linear title', () => {
    expect(
      getLinearIssueWorkspaceName({
        identifier: 'ENG-42',
        title: 'ENG-42 Ship Linear parity'
      })
    ).toBe('eng-42-ship-linear-parity')
  })

  it('keeps the combined Linear seed within the workspace-name limit', () => {
    const seed = getLinearIssueWorkspaceName({
      identifier: 'ENG-42',
      title: 'Implement a very long Linear issue title that should be truncated'
    })
    expect(seed.length).toBeLessThanOrEqual(48)
    expect(seed).toMatch(/^eng-42-/)
  })
})

describe('resolveWorkspaceCreateName', () => {
  it('preserves explicit user-entered names for the host worktree sanitizer', () => {
    expect(
      resolveWorkspaceCreateName({
        draft: 'feature/something',
        fallback: 'issue-123'
      })
    ).toBe('feature/something')
    expect(
      resolveWorkspaceCreateName({
        draft: '日本語 テスト',
        fallback: 'issue-123'
      })
    ).toBe('日本語 テスト')
  })

  it('uses the stable fallback when the draft is blank', () => {
    expect(resolveWorkspaceCreateName({ draft: '   ', fallback: 'pr-9' })).toBe('pr-9')
    expect(resolveWorkspaceCreateName({ draft: undefined, fallback: 'issue-4' })).toBe('issue-4')
  })
})
