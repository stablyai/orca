import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const COMPONENT_ROOT = __dirname

function componentSource(relativePath: string): string {
  return readFileSync(join(COMPONENT_ROOT, relativePath), 'utf8')
}

function expectTranslationCopy(
  source: string,
  entries: readonly { key: string; fallback: string }[]
): void {
  for (const entry of entries) {
    expect(source).toContain(`'${entry.key}'`)
    expect(source).toContain(`'${entry.fallback}'`)
  }
}

describe('complete localized action and count copy', () => {
  it.each([
    {
      component: 'PullRequestPage.tsx',
      namespace: 'auto.components.PullRequestPage',
      oldViewedKey: 'auto.components.PullRequestPage.ff84e1f54c',
      oldReactionKey: 'auto.components.PullRequestPage.42c36d9166',
      oldActionTitleKey: 'auto.components.PullRequestPage.eec3706a6a',
      oldActionFailedKey: 'auto.components.PullRequestPage.b8c6cbb8c4'
    },
    {
      component: 'GitHubItemDialog.tsx',
      namespace: 'auto.components.GitHubItemDialog',
      oldViewedKey: 'auto.components.GitHubItemDialog.2d89a38d9d',
      oldReactionKey: 'auto.components.GitHubItemDialog.a18f669c7a',
      oldActionTitleKey: 'auto.components.GitHubItemDialog.03d7216d62',
      oldActionFailedKey: 'auto.components.GitHubItemDialog.e9b7cb7d17'
    }
  ])('keeps $component visible actions and reaction plurals in full sentences', (entry) => {
    const source = componentSource(entry.component)

    expectTranslationCopy(source, [
      {
        key: `${entry.namespace}.markFileAsViewed`,
        fallback: 'Mark {{filePath}} as viewed'
      },
      {
        key: `${entry.namespace}.unmarkFileAsViewed`,
        fallback: 'Unmark {{filePath}} as viewed'
      },
      {
        key: `${entry.namespace}.oneReactionAriaLabel`,
        fallback: '{{count}} {{reactionEmoji}} reaction'
      },
      {
        key: `${entry.namespace}.manyReactionsAriaLabel`,
        fallback: '{{count}} {{reactionEmoji}} reactions'
      },
      {
        key: `${entry.namespace}.confirmClosePullRequestTitle`,
        fallback: 'Close PR #{{number}}?'
      },
      {
        key: `${entry.namespace}.closePullRequestConfirmLabel`,
        fallback: 'Close'
      },
      {
        key: `${entry.namespace}.failedToClosePullRequest`,
        fallback: 'Failed to close PR'
      },
      {
        key: `${entry.namespace}.confirmReopenPullRequestTitle`,
        fallback: 'Reopen PR #{{number}}?'
      },
      {
        key: `${entry.namespace}.reopenPullRequestConfirmLabel`,
        fallback: 'Reopen'
      },
      {
        key: `${entry.namespace}.failedToReopenPullRequest`,
        fallback: 'Failed to reopen PR'
      },
      {
        key: `${entry.namespace}.squashAndMergeLabel`,
        fallback: 'Squash and merge'
      },
      {
        key: `${entry.namespace}.createMergeCommitLabel`,
        fallback: 'Create merge commit'
      },
      {
        key: `${entry.namespace}.rebaseAndMergeLabel`,
        fallback: 'Rebase and merge'
      },
      {
        key: `${entry.namespace}.confirmSquashAndMergeTitle`,
        fallback: 'Squash and merge PR #{{number}}?'
      },
      {
        key: `${entry.namespace}.confirmCreateMergeCommitTitle`,
        fallback: 'Create merge commit for PR #{{number}}?'
      },
      {
        key: `${entry.namespace}.confirmRebaseAndMergeTitle`,
        fallback: 'Rebase and merge PR #{{number}}?'
      }
    ])
    expect(source).not.toContain(entry.oldViewedKey)
    expect(source).not.toContain(entry.oldReactionKey)
    expect(source).not.toContain(entry.oldActionTitleKey)
    expect(source).not.toContain(entry.oldActionFailedKey)
    expect(source).not.toContain('{{value0}} {{value1}} as viewed')
    expect(source).not.toContain('reaction{{value2}}')
    expect(source).not.toContain('reaction: reaction.content')
    expect(source).toContain('reactionEmoji: REACTION_EMOJI[reaction.content]')
    expect(source).not.toContain('GITHUB_PR_MERGE_METHOD_LABELS')
    expect(source).not.toContain("const label = nextState === 'closed' ? 'Close' : 'Reopen'")
  })

  it('uses complete shared member and label count phrases in TaskPage', () => {
    const source = componentSource('TaskPage.tsx')

    expectTranslationCopy(source, [
      {
        key: 'auto.components.TaskPage.oneSelectedMember',
        fallback: '{{count}} member'
      },
      {
        key: 'auto.components.TaskPage.manySelectedMembers',
        fallback: '{{count}} members'
      },
      {
        key: 'auto.components.TaskPage.oneSelectedLabel',
        fallback: '{{count}} label'
      },
      {
        key: 'auto.components.TaskPage.manySelectedLabels',
        fallback: '{{count}} labels'
      }
    ])
    expect(source.match(/getSelectedLinearProjectMemberCountLabel\(/g)).toHaveLength(2)
    expect(source.match(/getSelectedLinearLabelCountLabel\(/g)).toHaveLength(3)
    expect(source).not.toContain('auto.components.TaskPage.7719d8daa9')
    expect(source).not.toContain('auto.components.TaskPage.eff9800d4b')
    expect(source).not.toContain('member{{value1}}')
    expect(source).not.toContain('label{{value1}}')
  })

  it('keeps the GitLab MR abbreviation and translated issue noun in separate TaskPage keys', () => {
    const source = componentSource('TaskPage.tsx')

    expectTranslationCopy(source, [
      {
        key: 'auto.components.TaskPage.startWorkspaceFromGitLabMR',
        fallback: 'Start workspace from MR {{number}}'
      },
      {
        key: 'auto.components.TaskPage.startWorkspaceFromGitLabIssue',
        fallback: 'Start workspace from issue {{number}}'
      }
    ])
    expect(source.match(/getGitLabStartWorkspaceAriaLabel\(/g)).toHaveLength(2)
    expect(source).not.toContain('auto.components.TaskPage.5e8061b088')
    expect(source).not.toContain('Start workspace from {{value0}} {{value1}}')
  })

  it('keeps highlighted worktree examples inside complete translatable sentences', () => {
    const source = componentSource(join('feature-tips', 'FeatureTipsModal.tsx'))

    expect(source).toContain(
      'translationKey="auto.components.feature.tips.FeatureTipsModal.splitWorktreesPrompt"'
    )
    expect(source).toContain(
      'fallback="“Split this PR into two {{term}} and create PRs for each.”"'
    )
    expect(source).toContain(
      'translationKey="auto.components.feature.tips.FeatureTipsModal.handoffReviewPrompt"'
    )
    expect(source).toContain(
      'fallback="“When the agent in {{term}} X finishes, send it the review task.”"'
    )
    expect(source).not.toContain('auto.components.feature.tips.FeatureTipsModal.55846c7f95')
    expect(source).not.toContain('auto.components.feature.tips.FeatureTipsModal.7fc6f02099')
    expect(source).not.toContain('auto.components.feature.tips.FeatureTipsModal.864e2db28f')
    expect(source).not.toContain('auto.components.feature.tips.FeatureTipsModal.3c6c478462')
  })

  it('uses complete discard-error and note-count phrases in SourceControl', () => {
    const source = componentSource(join('right-sidebar', 'SourceControl.tsx'))

    expectTranslationCopy(source, [
      {
        key: 'auto.components.right.sidebar.SourceControl.failedToDiscardOneFile',
        fallback: 'Failed to discard {{count}} file'
      },
      {
        key: 'auto.components.right.sidebar.SourceControl.failedToDiscardManyFiles',
        fallback: 'Failed to discard {{count}} files'
      },
      {
        key: 'auto.components.right.sidebar.SourceControl.oneNote',
        fallback: '{{count}} note'
      },
      {
        key: 'auto.components.right.sidebar.SourceControl.manyNotes',
        fallback: '{{count}} notes'
      },
      {
        key: 'auto.components.right.sidebar.SourceControl.abortRebaseTitle',
        fallback: 'Abort rebase?'
      },
      {
        key: 'auto.components.right.sidebar.SourceControl.abortRebaseDescription',
        fallback:
          'This cancels the rebase in progress and can discard conflict resolutions made during this rebase.'
      },
      {
        key: 'auto.components.right.sidebar.SourceControl.abortRebaseConfirmLabel',
        fallback: 'Abort rebase'
      },
      {
        key: 'auto.components.right.sidebar.SourceControl.abortRebaseFailed',
        fallback: 'Abort rebase failed'
      },
      {
        key: 'auto.components.right.sidebar.SourceControl.failedToAbortRebase',
        fallback: 'Failed to abort rebase'
      },
      {
        key: 'auto.components.right.sidebar.SourceControl.abortMergeTitle',
        fallback: 'Abort merge?'
      },
      {
        key: 'auto.components.right.sidebar.SourceControl.abortMergeDescription',
        fallback:
          'This cancels the merge in progress and can discard conflict resolutions made during this merge.'
      },
      {
        key: 'auto.components.right.sidebar.SourceControl.abortMergeConfirmLabel',
        fallback: 'Abort merge'
      },
      {
        key: 'auto.components.right.sidebar.SourceControl.abortMergeFailed',
        fallback: 'Abort merge failed'
      },
      {
        key: 'auto.components.right.sidebar.SourceControl.failedToAbortMerge',
        fallback: 'Failed to abort merge'
      }
    ])
    expect(source.match(/getFailedDiscardFileCountLabel\(/g)).toHaveLength(2)
    expect(source.match(/getDiffNoteCountLabel\(/g)).toHaveLength(3)
    expect(source).not.toContain('auto.components.right.sidebar.SourceControl.8eb3782a0c')
    expect(source).not.toContain('auto.components.right.sidebar.SourceControl.657e0c90ad')
    expect(source).not.toContain('auto.components.right.sidebar.SourceControl.f99560ab29')
    expect(source).not.toContain('file{{value1}}')
    expect(source).not.toContain('note{{value1}}')
    expect(source).not.toContain('Abort {{value0}} failed')
    expect(source).not.toContain('`Abort ${label}`')
  })
})
