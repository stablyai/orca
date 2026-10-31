import type { AiActionId } from './source-control-ai-actions'

/** Key the registry off hover descriptions so an undocumented chip fails compilation. */
export const SOURCE_CONTROL_ACTION_VARIABLES: Record<AiActionId, SourceControlActionVariable[]> = {
  commitMessage: ['basePrompt', 'branch', 'stagedFiles', 'stagedPatch', 'linkedIssue'],
  pullRequest: [
    'basePrompt',
    'branch',
    'baseBranch',
    'currentTitle',
    'currentBody',
    'commitSummary',
    'changedFiles',
    'patch',
    'linkedIssue'
  ],
  branchName: ['basePrompt', 'firstPrompt', 'assistantMessage'],
  conversationName: ['basePrompt', 'firstPrompt'],
  fixCommitFailure: ['basePrompt'],
  fixPushFailure: ['basePrompt'],
  fixChecks: ['basePrompt'],
  resolveConflicts: ['basePrompt'],
  resolveComments: ['basePrompt']
}

export type SourceControlActionVariableInfo = {
  description: string
  example: string
}

export const SOURCE_CONTROL_ACTION_VARIABLE_INFO = {
  basePrompt: {
    description:
      'Orca’s built-in prompt for this action, including the context Orca knows how to gather safely.',
    example:
      'Commit messages include staged diff guidance; PR details include branch comparison guidance; fix actions include the failure summary.'
  },
  branch: {
    description: 'The current source-control branch name.',
    example: 'feature/source-control-ai-recipes'
  },
  stagedFiles: {
    description: 'A newline-separated list of staged files for commit-message generation.',
    example: 'M src/shared/source-control-ai.ts\nA src/shared/source-control-ai-actions.ts'
  },
  stagedPatch: {
    description: 'The staged git patch used for commit-message generation.',
    example: 'diff --git a/src/app.ts b/src/app.ts\n+addActionRecipeDefaults()'
  },
  baseBranch: {
    description: 'The target branch selected in the Create PR composer.',
    example: 'main'
  },
  currentTitle: {
    description: 'The PR title currently typed in the composer before generation starts.',
    example: 'Improve Source Control AI customization'
  },
  currentBody: {
    description: 'The PR description currently typed in the composer before generation starts.',
    example: 'Adds configurable agents and command templates for Source Control actions.'
  },
  commitSummary: {
    description: 'A newline-separated list of commits on the branch compared to the base.',
    example: 'a1b2c3d Add action recipe defaults\nd4e5f6a Render command templates'
  },
  changedFiles: {
    description: 'A summary of files changed between the branch and the base branch.',
    example:
      'src/shared/source-control-ai-actions.ts | 24 +++++\nsrc/main/text-generation.ts | 8 +-'
  },
  patch: {
    description: 'The branch diff against the base branch used for PR-details generation.',
    example: 'diff --git a/src/app.ts b/src/app.ts\n+renderSourceControlActionCommandTemplate()'
  },
  firstPrompt: {
    description: 'The first user request for this workspace or chat.',
    example: 'Fix CI and commit the result'
  },
  assistantMessage: {
    description: 'The initial agent response, when Orca has one available.',
    example: 'I will inspect the failing check, patch the issue, and run tests.'
  },
  linkedIssue: {
    description:
      'The GitHub issue number linked to this workspace. Empty when no GitHub issue is linked (including GitLab-linked workspaces). Prefer instructional templates: a bare "Fixes #{linkedIssue}" becomes "Fixes #" when unlinked.',
    example: '123'
  }
} satisfies Record<string, SourceControlActionVariableInfo>

export type SourceControlActionVariable = keyof typeof SOURCE_CONTROL_ACTION_VARIABLE_INFO

/** Positive safe integers avoid corrupt issue references and String’s exponent notation at 1e+21. */
export function isLinkedIssueNumber(linkedIssue: unknown): linkedIssue is number {
  return typeof linkedIssue === 'number' && Number.isSafeInteger(linkedIssue) && linkedIssue > 0
}

export function formatLinkedIssueTemplateValue(linkedIssue: number | null | undefined): string {
  return isLinkedIssueNumber(linkedIssue) ? String(linkedIssue) : ''
}

/** Keep unlinked context shape unchanged. The linkedIssue constraint excludes contexts (e.g. branch naming) that never read it. */
export function withLinkedIssueDraftContext<T extends { linkedIssue?: number | null }>(
  context: T,
  linkedIssue: number | null | undefined
): T {
  return isLinkedIssueNumber(linkedIssue) ? { ...context, linkedIssue } : context
}
